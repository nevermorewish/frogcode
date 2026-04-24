#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Sync locally-edited files to the remote build host."""
from __future__ import annotations
import sys
from pathlib import Path
import paramiko

HOST = "183.147.142.40"
PORT = 30136
USER = "root"
PASSWORD = "sv6t5dhe"

PROJECT_ROOT = Path(__file__).resolve().parent.parent
REMOTE_ROOT = "/root/frogcode"

FILES = [
    "src-tauri/sidecar/platform/src/agents/openclaw/process.ts",
    "src/contexts/AuthContext.tsx",
    "src-tauri/binaries/frogcode-platform-sidecar.cjs",
]


def main():
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(HOST, port=PORT, username=USER, password=PASSWORD, timeout=30)
    try:
        sftp = client.open_sftp()
        for rel in FILES:
            local = PROJECT_ROOT / rel
            remote = f"{REMOTE_ROOT}/{rel}"
            assert local.exists(), f"missing: {local}"
            print(f"--> {remote} ({local.stat().st_size} bytes)")
            sftp.put(str(local), remote)
        sftp.close()

        # Verify
        for rel in FILES:
            remote = f"{REMOTE_ROOT}/{rel}"
            _, so, _ = client.exec_command(f"wc -c {remote}", timeout=10)
            print(so.read().decode().rstrip())
            so.channel.recv_exit_status()

        print("\nPatch beforeDevCommand line:")
        _, so, _ = client.exec_command(
            f"grep -n beforeDevCommand {REMOTE_ROOT}/src-tauri/tauri.conf.json",
            timeout=10)
        print(so.read().decode().rstrip())
        so.channel.recv_exit_status()
    finally:
        client.close()


if __name__ == "__main__":
    sys.exit(main() or 0)
