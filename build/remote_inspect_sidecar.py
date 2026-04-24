#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Capture sidecar stderr/stdout to files for later reading."""
from __future__ import annotations
import sys
import paramiko

HOST = "183.147.142.40"
PORT = 30136
USER = "root"
PASSWORD = "sv6t5dhe"


def run(client, cmd, timeout=120):
    print(f"$ {cmd}", flush=True)
    stdin, stdout, stderr = client.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode(errors="replace")
    err = stderr.read().decode(errors="replace")
    rc = stdout.channel.recv_exit_status()
    if out:
        print("STDOUT:")
        print(out)
    if err:
        print("STDERR:")
        print(err)
    print(f"[rc={rc}]\n")
    return rc, out, err


def main():
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(HOST, port=PORT, username=USER, password=PASSWORD, timeout=30)
    try:
        print("===== clear old log and run sidecar (to files) =====")
        run(client, "rm -f /tmp/sidecar-out.log /tmp/sidecar-err.log")
        run(client,
            "cd /tmp && (timeout 7 node /root/.frogcode/frogcode-platform-sidecar.cjs --port 0 "
            "> /tmp/sidecar-out.log 2> /tmp/sidecar-err.log; echo EXIT=$?) 2>&1",
            timeout=30)

        print("===== sidecar stdout =====")
        run(client, "wc -c /tmp/sidecar-out.log; cat /tmp/sidecar-out.log | head -200")

        print("===== sidecar stderr =====")
        run(client, "wc -c /tmp/sidecar-err.log; cat /tmp/sidecar-err.log | head -200")

        print("===== check for node import errors by loading ONLY =====")
        run(client,
            "node --trace-uncaught -e \"try { require('/root/.frogcode/frogcode-platform-sidecar.cjs') } "
            "catch(e) { console.error('REQUIRE_ERR:', e.stack || e.message) }\" 2> /tmp/req.err; "
            "head -100 /tmp/req.err",
            timeout=30)

    finally:
        client.close()


if __name__ == "__main__":
    main()
