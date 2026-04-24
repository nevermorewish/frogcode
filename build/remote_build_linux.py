#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
Remote Linux build script for Frog Code.

Pipeline:
  1. tar up the project locally (excluding heavy/generated dirs)
  2. upload to the remote Linux box via SFTP
  3. install system deps + Rust toolchain (idempotent)
  4. run build-linux.sh
  5. download .deb / .rpm / .AppImage / binary to ./dist-linux/

Usage:
    python scripts/remote_build_linux.py
"""
from __future__ import annotations

import os
import sys
import tarfile
import time
from pathlib import Path

import paramiko

HOST = "183.147.142.40"
PORT = 30136
USER = "root"
PASSWORD = "sv6t5dhe"

PROJECT_ROOT = Path(__file__).resolve().parent.parent
REMOTE_HOME = "/root"
REMOTE_PROJECT = f"{REMOTE_HOME}/frogcode"
REMOTE_TARBALL = f"{REMOTE_HOME}/frogcode-src.tar.gz"
LOCAL_TARBALL = PROJECT_ROOT / "dist-linux" / "frogcode-src.tar.gz"
LOCAL_OUTPUT = PROJECT_ROOT / "dist-linux"

EXCLUDE_DIRS = {
    "node_modules",
    "target",
    ".git",
    "dist",
    "dist-linux",
    "dist-web",
    ".next",
    ".turbo",
}
EXCLUDE_SUFFIX = (".log",)


# ---------- helpers ----------------------------------------------------------
def log(msg: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def make_tarball() -> Path:
    LOCAL_OUTPUT.mkdir(parents=True, exist_ok=True)
    log(f"Creating tarball: {LOCAL_TARBALL}")

    def tar_filter(info: tarfile.TarInfo):
        parts = Path(info.name).parts
        if any(p in EXCLUDE_DIRS for p in parts):
            return None
        if info.name.endswith(EXCLUDE_SUFFIX):
            return None
        # normalize owner
        info.uid = 0
        info.gid = 0
        info.uname = "root"
        info.gname = "root"
        return info

    with tarfile.open(LOCAL_TARBALL, "w:gz", compresslevel=6) as tar:
        tar.add(str(PROJECT_ROOT), arcname="frogcode", filter=tar_filter)

    size_mb = LOCAL_TARBALL.stat().st_size / 1024 / 1024
    log(f"Tarball size: {size_mb:.2f} MB")
    return LOCAL_TARBALL


def open_ssh() -> paramiko.SSHClient:
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(
        HOST, port=PORT, username=USER, password=PASSWORD, timeout=30,
        banner_timeout=30, auth_timeout=30,
    )
    transport = client.get_transport()
    if transport is not None:
        transport.set_keepalive(30)
    return client


def run(client: paramiko.SSHClient, cmd: str, *, check: bool = True,
        pty: bool = False, timeout: int | None = None) -> int:
    log(f"$ {cmd}")
    stdin, stdout, stderr = client.exec_command(cmd, get_pty=pty, timeout=timeout)
    # stream output
    channel = stdout.channel
    buf_out, buf_err = b"", b""
    while True:
        if channel.recv_ready():
            data = channel.recv(4096)
            if data:
                sys.stdout.write(data.decode(errors="replace"))
                sys.stdout.flush()
        if channel.recv_stderr_ready():
            data = channel.recv_stderr(4096)
            if data:
                sys.stderr.write(data.decode(errors="replace"))
                sys.stderr.flush()
        if channel.exit_status_ready() and not channel.recv_ready() \
                and not channel.recv_stderr_ready():
            break
        time.sleep(0.05)
    # drain remaining
    while channel.recv_ready():
        sys.stdout.write(channel.recv(4096).decode(errors="replace"))
    while channel.recv_stderr_ready():
        sys.stderr.write(channel.recv_stderr(4096).decode(errors="replace"))
    rc = channel.recv_exit_status()
    if check and rc != 0:
        raise RuntimeError(f"Remote command failed (rc={rc}): {cmd}")
    return rc


def upload(client: paramiko.SSHClient, local: Path, remote: str) -> None:
    sftp = client.open_sftp()
    total = local.stat().st_size
    last = [0, time.time()]

    def progress(sent: int, _total: int) -> None:
        now = time.time()
        if now - last[1] >= 1.0 or sent == total:
            mb = sent / 1024 / 1024
            pct = sent / total * 100
            speed = (sent - last[0]) / 1024 / 1024 / max(now - last[1], 0.001)
            sys.stdout.write(f"\r  upload: {mb:.1f} MB ({pct:5.1f}%) "
                             f"@ {speed:.2f} MB/s   ")
            sys.stdout.flush()
            last[0], last[1] = sent, now

    log(f"Uploading {local.name} -> {remote}")
    sftp.put(str(local), remote, callback=progress)
    print()
    sftp.close()


def download_artifacts(client: paramiko.SSHClient) -> None:
    sftp = client.open_sftp()
    remote_bundle = f"{REMOTE_PROJECT}/src-tauri/target/release/bundle"
    remote_bin = f"{REMOTE_PROJECT}/src-tauri/target/release/frog-code"

    # List deb / rpm / AppImage recursively.
    find_cmd = (
        f"find {remote_bundle} -type f "
        f"\\( -name '*.deb' -o -name '*.rpm' -o -name '*.AppImage' \\) 2>/dev/null"
    )
    stdin, stdout, stderr = client.exec_command(find_cmd)
    files = [l.strip() for l in stdout.read().decode().splitlines() if l.strip()]

    # Also grab main binary if present
    stdin, stdout, _ = client.exec_command(f"test -f {remote_bin} && echo {remote_bin} || true")
    extra = stdout.read().decode().strip()
    if extra:
        files.append(extra)

    LOCAL_OUTPUT.mkdir(parents=True, exist_ok=True)
    for rf in files:
        name = Path(rf).name
        local_path = LOCAL_OUTPUT / name
        log(f"Downloading {rf} -> {local_path}")
        sftp.get(rf, str(local_path))
    sftp.close()
    log(f"Artifacts landed in: {LOCAL_OUTPUT}")


# ---------- main -------------------------------------------------------------
def main() -> int:
    tarball = make_tarball()

    client = open_ssh()
    try:
        # Prep remote dirs.
        run(client, f"rm -rf {REMOTE_PROJECT} && mkdir -p {REMOTE_PROJECT}")

        # Upload.
        upload(client, tarball, REMOTE_TARBALL)

        # Extract.
        run(client, f"tar -xzf {REMOTE_TARBALL} -C {REMOTE_HOME} && ls {REMOTE_PROJECT} | head")

        # System deps (idempotent; only installs what's missing).
        deps_cmd = (
            "export DEBIAN_FRONTEND=noninteractive && "
            "apt-get update -qq && "
            "apt-get install -y --no-install-recommends "
            "  libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev "
            "  libssl-dev pkg-config build-essential curl wget "
            "  libayatana-appindicator3-dev file patchelf rsync ca-certificates"
        )
        run(client, deps_cmd, pty=True)

        # Rust toolchain (install rustup if missing). Use rsproxy.cn mirror
        # because the default rust-lang.org CDN is extremely slow from this host.
        rust_cmd = (
            "export RUSTUP_DIST_SERVER=https://rsproxy.cn && "
            "export RUSTUP_UPDATE_ROOT=https://rsproxy.cn/rustup && "
            "if ! command -v cargo >/dev/null 2>&1 && "
            "[ ! -x $HOME/.cargo/bin/cargo ]; then "
            "  curl --proto '=https' --tlsv1.2 -sSf https://rsproxy.cn/rustup-init.sh "
            "  | sh -s -- -y --default-toolchain stable --profile minimal; "
            "fi && "
            "export PATH=$HOME/.cargo/bin:$PATH && "
            "rustc --version && cargo --version"
        )
        run(client, rust_cmd, pty=True)

        # Configure cargo to use rsproxy mirror for crates.io.
        cargo_cfg_cmd = (
            "mkdir -p $HOME/.cargo && "
            "cat > $HOME/.cargo/config.toml <<'EOF'\n"
            "[source.crates-io]\n"
            "replace-with = 'rsproxy-sparse'\n"
            "[source.rsproxy]\n"
            "registry = \"https://rsproxy.cn/crates.io-index\"\n"
            "[source.rsproxy-sparse]\n"
            "registry = \"sparse+https://rsproxy.cn/index/\"\n"
            "[registries.rsproxy]\n"
            "index = \"https://rsproxy.cn/crates.io-index\"\n"
            "[net]\n"
            "git-fetch-with-cli = true\n"
            "EOF"
        )
        run(client, cargo_cfg_cmd)

        # npm mirror — use npmmirror.com for speed inside CN.
        npm_cfg_cmd = (
            "npm config set registry https://registry.npmmirror.com"
        )
        run(client, npm_cfg_cmd)

        # Normalize CRLF → LF for any shell scripts that came from Windows.
        run(client, f"cd {REMOTE_PROJECT} && "
                    "find . -maxdepth 2 -name '*.sh' -exec sed -i 's/\\r$//' {} +")

        # Build.
        build_cmd = (
            f"cd {REMOTE_PROJECT} && "
            "export PATH=$HOME/.cargo/bin:$PATH && "
            "chmod +x build-linux.sh && "
            "bash build-linux.sh"
        )
        run(client, build_cmd, pty=True, timeout=60 * 60)

        # Download artifacts.
        download_artifacts(client)

    finally:
        client.close()

    log("Done.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
