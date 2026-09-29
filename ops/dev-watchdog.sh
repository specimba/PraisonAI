#!/bin/bash
# Dev-server watchdog v2 (r124) — root cause of every "preview broken" incident:
# next-server RSS grows through HMR edits until the kernel OOM-kills it
# (dmesg 2026-09-29: killed at anon-rss 2.3GB). The sandbox also reaps
# processes started from cron sessions, so ONLY this main-session watchdog
# can keep the app alive.
# Loop (20s): if :3000 != 200 → reap stale QA chrome (frees RAM) → restart
# `bun run dev` with a 1.5GB V8 heap cap (GC hard before the kernel does).
# Runaway guard: 5 consecutive failed restarts → 5min cooldown.
cd /home/z/my-project
fails=0
while true; do
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 http://localhost:3000)
  if [ "$code" != "200" ]; then
    fails=$((fails+1))
    rss=$(ps -eo args,rss | grep "next-server" | grep -v grep | awk '{s+=$2} END {print int(s/1024)"MB"}')
    if [ $fails -le 5 ]; then
      echo "$(date -u +%FT%TZ) down (http=$code, next-server rss=${rss:-0MB}) — restart #$fails" >> ops/watchdog.log
      pkill -f "agent-browser.*chrome" 2>/dev/null; sleep 1   # stale QA browsers eat RAM
      pkill -f "next dev" 2>/dev/null; pkill -f "next-server" 2>/dev/null; sleep 2
      NODE_OPTIONS="--max-old-space-size=1536" setsid nohup node node_modules/next/dist/bin/next dev -p 3000 >> dev.log 2>&1 < /dev/null &
      sleep 12
    else
      if [ $fails -eq 6 ]; then echo "$(date -u +%FT%TZ) 5 restarts failed — cooling down 5min" >> ops/watchdog.log; fi
      sleep 300
    fi
  else
    fails=0
  fi
  sleep 20
done
