#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Upload freshly-built sidecar to remote /root/.frogcode and verify it starts."""
from __future__ import annotations
import sys
import time
from pathlib import Path
import paramiko

HOST = "183.147.142.40"
PORT = 30136
USER = "root"
PASSWORD = "sv6t5dhe"

LOCAL = Path(__file__).resolve().parent.parent / "src-tauri" / "binaries" / "frogcode-platform-sidecar.cjs"
REMOTE_USER_COPY = "/root/.frogcode/frogcode-platform-sidecar.cjs"
REMOTE_APP_COPIES = [
    "/root/frogcode/src-tauri/binaries/frogcode-platform-sidecar.cjs",
    "/root/Desktop/frogcode-main/src-tauri/binaries/frogcode-platform-sidecar.cjs",
]


def run(client, cmd, timeout=120):
    print(f"$ {cmd}", flush=True)
    si, so, se = client.exec_command(cmd, timeout=timeout)
    out = so.read().decode(errors="replace")
    err = se.read().decode(errors="replace")
    rc = so.channel.recv_exit_status()
    if out:
        print(out, end="" if out.endswith("\n") else "\n")
    if err:
        print("STDERR:", err, file=sys.stderr)
    print(f"[rc={rc}]\n")
    return rc, out, err


def main():
    assert LOCAL.exists(), f"missing: {LOCAL}"
    print(f"Local bundle: {LOCAL} ({LOCAL.stat().st_size} bytes)")
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(HOST, port=PORT, username=USER, password=PASSWORD, timeout=30)
    try:
        # Upload
        sftp = client.open_sftp()
        for rp in [REMOTE_USER_COPY, *REMOTE_APP_COPIES]:
            print(f"--> uploading to {rp}")
            try:
                sftp.stat(Path(rp).parent.as_posix())
            except IOError:
                print(f"    (parent dir missing, skipping: {rp})")
                continue
            sftp.put(str(LOCAL), rp)
            si, so, se = client.exec_command(f"chmod +x {rp}")
            so.channel.recv_exit_status()
        sftp.close()

        # Sanity: capture startup output
        print("===== launching fixed sidecar (12s) =====")
        run(client, "rm -f /tmp/sc_out.new /tmp/sc_err.new")
        run(client,
            "cd /root/.frogcode && "
            "(timeout 12 /usr/local/bin/node frogcode-platform-sidecar.cjs --port 0 "
            "--config /root/.frogcode/platform-config.json "
            "> /tmp/sc_out.new 2> /tmp/sc_err.new </dev/null; echo EXIT=$?)",
            timeout=30)

        print("===== stdout =====")
        run(client, "wc -c /tmp/sc_out.new; sed -n '1,20p' /tmp/sc_out.new")
        print("===== stderr (first 60 lines) =====")
        run(client, "wc -c /tmp/sc_err.new; sed -n '1,60p' /tmp/sc_err.new")

    finally:
        client.close()


if __name__ == "__main__":
    main()
