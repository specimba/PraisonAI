#!/usr/bin/env bash
# ─── dev-watchdog (post-OOM hardening, 2026-09-26) ──────────────────────────
# Root cause of the 08:44Z outage: kernel OOM-killed next-server at 3.1 GB RSS
# on the 4 GB sandbox. Recovery previously depended on the next cron round
# (40+ min downtime). This watchdog bounds it to ~1-2 min.
#
# Behavior: probe :3000 every 60s; if not HTTP 200, restart the dev server
# using the ORIGINAL launch command. NOTE: do NOT add NODE_OPTIONS heap caps —
# tested 2026-09-26 09:26Z: --max-old-space-size=2560 made next-server crash
# silently during the first big Turbopack compile (twice). Uncapped, it runs
# ~35 min before kernel OOM at ~3.1GB — the watchdog's job is to cover that
# window with a bounded ~1-2 min restart. Future fix: production build.

APP_DIR=/home/z/my-project
LOG=$APP_DIR/ops/watchdog.log
PIDFILE=$APP_DIR/ops/watchdog.pid
URL=http://127.0.0.1:3000

# single-instance guard
if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE" 2>/dev/null)" 2>/dev/null; then
  echo "watchdog already running (pid $(cat "$PIDFILE"))" >&2
  exit 0
fi
echo $$ > "$PIDFILE"

LAST_RESTART=0
while true; do
  CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "$URL" 2>/dev/null)
  NOW=$(date +%s)
  if [ "$CODE" != "200" ]; then
    if [ $((NOW - LAST_RESTART)) -ge 300 ]; then
      echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) http=$CODE -> restarting dev (original cmd)" >> "$LOG"
      cd "$APP_DIR" || exit 1
      setsid nohup bun run dev > /dev/null 2>&1 &
      LAST_RESTART=$NOW
      sleep 20
    else
      echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) http=$CODE (cooldown, no restart)" >> "$LOG"
    fi
  fi
  sleep 60
done
