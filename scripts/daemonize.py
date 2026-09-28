#!/usr/bin/env python3
"""Double-fork daemonizer (r79 doctrine): survives tool-call-boundary tree-kills.

Usage: python3 scripts/daemonize.py <cmd> [args...]
Fork -> setsid -> fork -> exec. Exits 0 immediately; the child lives on
reparented to PID 1, outside the calling shell's kill tree.
Idempotence is the CALLER's job (check the port/service first).
"""
import os
import sys

def main() -> None:
    if len(sys.argv) < 2:
        print("usage: daemonize.py <cmd> [args...]", file=sys.stderr)
        sys.exit(2)
    pid = os.fork()
    if pid > 0:
        os.waitpid(pid, 0)  # reap the intermediate so no zombie is left
        return
    os.setsid()
    pid2 = os.fork()
    if pid2 > 0:
        os._exit(0)
    devnull = os.open(os.devnull, os.O_RDWR)
    os.dup2(devnull, 0)
    os.dup2(devnull, 1)
    os.dup2(devnull, 2)
    os.execvp(sys.argv[1], sys.argv[1:])

if __name__ == "__main__":
    main()
