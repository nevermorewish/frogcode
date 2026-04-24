#!/usr/bin/env python
"""Patch the remote copy of claude_binary.rs with the local fix, rebuild the
Tauri bundle (cargo cache is warm so this is fast), and pull the new
.deb/.rpm/binary back.
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

import paramiko

HOST = "183.147.142.40"
PORT = 30136
USER = "root"
PASSWORD = "sv6t5dhe"

PROJECT = Path(__file__).resolve().parent.parent
LOCAL_FILE = PROJECT / "src-tauri" / "src" / "claude_binary.rs"
REMOTE_FILE = "/root/frogcode/src-tauri/src/claude_binary.rs"
LOCAL_OUT = PROJECT / "dist-linux"


def log(msg: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def run(client: paramiko.SSHClient, cmd: str, *, pty: bool = False) -> int:
    log(f"$ {cmd}")
    stdin, stdout, stderr = client.exec_command(cmd, get_pty=pty)
    ch = stdout.channel
    while True:
        if ch.recv_ready():
            sys.stdout.write(ch.recv(4096).decode(errors="replace"))
            sys.stdout.flush()
        if ch.recv_stderr_ready():
            sys.stderr.write(ch.recv_stderr(4096).decode(errors="replace"))
            sys.stderr.flush()
        if ch.exit_status_ready() and not ch.recv_ready() and not ch.recv_stderr_ready():
            break
        time.sleep(0.05)
    while ch.recv_ready():
        sys.stdout.write(ch.recv(4096).decode(errors="replace"))
    while ch.recv_stderr_ready():
        sys.stderr.write(ch.recv_stderr(4096).decode(errors="replace"))
    rc = ch.recv_exit_status()
    if rc != 0:
        raise RuntimeError(f"remote command failed rc={rc}: {cmd}")
    return rc


def main() -> int:
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(HOST, port=PORT, username=USER, password=PASSWORD, timeout=30)
    tr = client.get_transport()
    if tr is not None:
        tr.set_keepalive(30)
    try:
        log(f"Uploading patched {LOCAL_FILE.name}")
        sftp = client.open_sftp()
        sftp.put(str(LOCAL_FILE), REMOTE_FILE)
        sftp.close()

        # Normalize line endings just in case.
        run(client, f"sed -i 's/\\r$//' {REMOTE_FILE}")

        # Incremental rebuild — cargo will reuse the cached deps, so only
        # claude_binary.rs and the two downstream bins get recompiled.
        build_cmd = (
            "cd /root/frogcode && "
            "export PATH=$HOME/.cargo/bin:$PATH && "
            "export RUSTFLAGS='-A dead_code' && "
            "cd src-tauri && "
            "cargo build --release --bins 2>&1 | tail -80"
        )
        run(client, build_cmd, pty=True)

        # Rebundle just deb + rpm (AppImage download fails from CN).
        bundle_cmd = (
            "cd /root/frogcode && "
            "export PATH=$HOME/.cargo/bin:$PATH && "
            "npx tauri build --bundles deb,rpm --no-bundle 2>/dev/null || "
            "npx tauri bundle --bundles deb,rpm 2>&1 | tail -40"
        )
        # Tauri CLI versions differ on the flag; try both forms.
        run(client, bundle_cmd, pty=True)

        # Pull artifacts.
        sftp = client.open_sftp()
        stdin, stdout, _ = client.exec_command(
            "find /root/frogcode/src-tauri/target/release/bundle -type f "
            "\\( -name '*.deb' -o -name '*.rpm' \\) 2>/dev/null"
        )
        stdout.channel.recv_exit_status()
        files = [l.strip() for l in stdout.read().decode().splitlines() if l.strip()]
        files.append("/root/frogcode/src-tauri/target/release/frog-code")

        LOCAL_OUT.mkdir(parents=True, exist_ok=True)
        for rf in files:
            name = Path(rf).name
            local = LOCAL_OUT / name
            log(f"Downloading {rf}")
            sftp.get(rf, str(local))
        sftp.close()
        log("Done.")
    finally:
        client.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
