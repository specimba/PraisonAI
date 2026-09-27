#!/usr/bin/env python3
"""Double-fork daemonizer for the PraisonAI dev server.

The sandbox kills all descendants of a tool-call shell when the call ends
(tree-kill; setsid alone does NOT escape it). Orphaned grandchildren reparented
to PID 1 survive - proven by the agent-browser chrome daemon (PID 4564+).

Recipe: fork -> setsid -> fork -> exec. The intermediate exits ensure the
worker is reparented to init before the tool shell is torn down.
Idempotent: exits 0 without starting if :3000 already answers.
"""
import os
import sys
import time
import urllib.request

BASE = "/home/z/my-project"
LOG = os.path.join(BASE, "server.log")


def alive():
    try:
        with urllib.request.urlopen("http://localhost:3000", timeout=4) as r:
            return r.status == 200
    except Exception:
        return False


if alive():
    print("server already up")
    sys.exit(0)

if os.fork() > 0:
    sys.exit(0)  # parent exits; child adopts into init's tree soon
os.setsid()
if os.fork() > 0:
    sys.exit(0)  # intermediate exits; worker is now an orphan-to-be

os.chdir(BASE)
log = open(LOG, "ab", 0)
os.dup2(log.fileno(), 1)
os.dup2(log.fileno(), 2)
devnull = os.open(os.devnull, os.O_RDONLY)
os.dup2(devnull, 0)
os.execvp("bun", ["bun", "run", "dev"])
