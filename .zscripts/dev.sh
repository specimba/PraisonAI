#!/usr/bin/env bash
# ─── Boot-time service script (platform hook) ───────────────────────────────
# start.sh runs THIS instead of the default bun flow when it exists.
#
# WHY: dev-mode Turbopack grows RSS ~4MB/s under load (1.4GB → 3.1GB) and the
# 4GB sandbox cgroup OOM-kills it in ~5-30 min — incident 2026-09-26T08:44Z
# (silent kills, no error output; diagnosed live in the r67.1 session).
# The production standalone server sits flat at ~125MB.
#
# Policy: install deps → push db → start PRODUCTION if a standalone build
# exists (fast boot, no build at boot — the FC health check budget is ~120s);
# fall back to dev mode only when no build is present.
# After code changes: rebuild with `bun run build` then restart the server
# (kill server.js pid; bun run start) — otherwise the stale build keeps
# serving until the next container reboot.

set -e
cd /home/z/my-project

echo "[dev.sh] installing dependencies..."
bun install

echo "[dev.sh] pushing database schema..."
bun run db:push || echo "[dev.sh] db:push failed (continuing — schema may be current)"

if [ -f .next/standalone/server.js ]; then
  echo "[dev.sh] starting PRODUCTION standalone server (lean, OOM-safe)"
  echo "$(git rev-parse HEAD 2>/dev/null || echo unknown)" > .build-commit
  exec bun run start
else
  echo "[dev.sh] no standalone build found — falling back to dev mode (OOM risk!)"
  exec bun run dev
fi
