#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Download .deb / .rpm / bare binary from the remote build host."""
from __future__ import annotations
import sys
import time
from pathlib import Path
import paramiko

HOST = "183.147.142.40"
PORT = 30136
USER = "root"
PASSWORD = "sv6t5dhe"

PROJECT_ROOT = Path(__file__).resolve().parent.parent
LOCAL_OUTPUT = PROJECT_ROOT / "dist-linux"
REMOTE_BUNDLE = "/root/frogcode/src-tauri/target/release/bundle"
REMOTE_BIN = "/root/frogcode/src-tauri/target/release/frog-code"


def main():
    LOCAL_OUTPUT.mkdir(parents=True, exist_ok=True)
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(HOST, port=PORT, username=USER, password=PASSWORD, timeout=30)
    try:
        sftp = client.open_sftp()

        # find .deb/.rpm/.AppImage
        find_cmd = (
            f"find {REMOTE_BUNDLE} -type f "
            f"\\( -name '*.deb' -o -name '*.rpm' -o -name '*.AppImage' \\) 2>/dev/null"
        )
        si, so, se = client.exec_command(find_cmd, timeout=30)
        files = [l.strip() for l in so.read().decode().splitlines() if l.strip()]
        so.channel.recv_exit_status()

        # bare binary
        si, so, se = client.exec_command(
            f"test -f {REMOTE_BIN} && echo {REMOTE_BIN} || true", timeout=15)
        extra = so.read().decode().strip()
        so.channel.recv_exit_status()
        if extra:
            files.append(extra)

        if not files:
            print("No artifacts found on remote!", file=sys.stderr)
            return 1

        for rf in files:
            name = Path(rf).name
            local = LOCAL_OUTPUT / name
            size = sftp.stat(rf).st_size
            t0 = time.time()

            def cb(sent, total=size):
                pct = sent / total * 100 if total else 0
                mb = sent / 1024 / 1024
                sys.stdout.write(f"\r  {name}: {mb:6.1f} MB ({pct:5.1f}%)")
                sys.stdout.flush()

            print(f"--> {rf} ({size/1024/1024:.2f} MB)")
            sftp.get(rf, str(local), callback=cb)
            print(f"   done in {time.time()-t0:.1f}s -> {local}")
        sftp.close()

        print(f"\nArtifacts in: {LOCAL_OUTPUT}")
        for p in sorted(LOCAL_OUTPUT.iterdir()):
            if p.is_file():
                print(f"  {p.name}  {p.stat().st_size/1024/1024:.2f} MB")
    finally:
        client.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
