"use client";

import * as React from "react";
import { toast } from "sonner";
import { useWorkflowsStore } from "@/lib/stores";
import { executeWorkflowRun, isWorkflowRunning } from "@/lib/workflow-runner";
import { closeScheduleDeferral, noteScheduleDeferred } from "@/lib/schedule-skips";
import { gatewayQuietUntil, MAX_AUTO_RESUME_TRIPS } from "@/lib/gateway-cadence";

// ─── In-app workflow scheduler ───────────────────────────────────────────────
// Ticks every 10s and fires any enabled workflow schedule whose nextRunAt is
// due — INCLUDING when the browser tab is in the background (r71: users run
// pipelines unattended; browsers throttle timers there to ~1/min, which the
// re-arm logic absorbs: each due schedule simply runs once on the next tick
// and re-arms from "now"). A fully CLOSED tab still cannot run anything —
// the engine is client-side by design.

const TICK_MS = 10_000;

// ─── v24: politeness governor (the 429-burst killer) ────────────────────────
// Live evidence 2026-09-29: Deep (9 steps) + RSIinFIELD (5 steps) fired on
// the SAME second (aligned 1h schedules, no spacing) and burst the shared
// free gateway into 429 exhaustion. Two rules fix it:
//   1. START SPACING — two scheduled runs never start within 75s of each
//      other; the loser is re-armed just past the window (never lost).
//   2. JITTER — re-armed intervals get ±10%, so equal intervals that align
//      once can never stay aligned forever.
// Plus gateway-cadence: a 429 ANYWHERE quiets all scheduled starts 90s.
const START_SPACING_MS = 75_000;
const jitter = (ms: number) => Math.round(ms * (0.9 + Math.random() * 0.2));
let lastScheduledStartAt = 0;

/** Module-level singleton guard (StrictMode mounts effects twice). */
let ticking = false;

export function WorkflowScheduler() {
  React.useEffect(() => {
    const tick = () => {
      if (ticking) return;
      ticking = true;
      try {
        const now = Date.now();
        const store = useWorkflowsStore.getState();

        // r171: congestion auto-resume — a rate-limit-tripped breaker re-arms
        // ITSELF once its backoff elapses (the runner sets enabled:false +
        // autoResumeAt; this tick flips it back on). The failure streak is
        // deliberately preserved so a still-saturated gateway re-trips into a
        // LONGER backoff; a successful run resets both counters (runner).
        // Stale-flag safety: autoResumeAt is cleared on every other
        // enabled↔disabled transition (manual resume/pause), so a resurrected
        // schedule can only ever come from the congestion path.
        for (const wf of store.workflows) {
          const s = wf.schedule;
          if (s && !s.enabled && typeof s.autoResumeAt === "number" && s.autoResumeAt <= now) {
            store.update(wf.id, {
              schedule: { ...s, enabled: true, autoResumeAt: undefined, nextRunAt: now },
            });
            const left = Math.max(0, MAX_AUTO_RESUME_TRIPS - (s.autoResumeTrips ?? 0));
            toast("Gateway backoff elapsed — schedule auto-resumed", {
              icon: "⏰",
              description: `"${wf.name}" was parked by rate-limit backoff and is live again (streak ${s.failStreak ?? 0} preserved · ${left} auto-resume${left === 1 ? "" : "s"} left before a manual pause).`,
            });
          }
        }

        const due = store.workflows.filter(
          (w) =>
            w.schedule?.enabled === true &&
            w.steps.length > 0 &&
            (w.schedule.nextRunAt == null || w.schedule.nextRunAt <= now) &&
            !isWorkflowRunning(w.id)
        );

        // r77: audit the deliberate skips — a due schedule whose workflow is
        // already running is deferred (never lost; the first tick after the
        // run ends fires). Episodes are logged ONCE (noteScheduleDeferred is
        // idempotent per episode — no 10s-tick spam) and closed when the
        // schedule finally fires below.
        const blocked = store.workflows.filter(
          (w) =>
            w.schedule?.enabled === true &&
            w.steps.length > 0 &&
            (w.schedule.nextRunAt == null || w.schedule.nextRunAt <= now) &&
            isWorkflowRunning(w.id)
        );
        for (const wf of blocked) noteScheduleDeferred(wf.id, wf.name);

        for (const wf of due) {
          const schedule = wf.schedule;
          if (!schedule) continue;
          const interval = Math.max(60_000, schedule.intervalMs);
          const task =
            schedule.task.trim() ||
            (wf.description.trim()
              ? `Scheduled run — ${wf.description.trim()}`
              : "Scheduled run — carry out this pipeline as designed.");

          // v24: cadence gate — wait for start-spacing AND the gateway's
          // 429 quiet window. The run is deferred (never lost): re-arm just
          // past the gate so it fires on a later tick, alone.
          const earliest = Math.max(lastScheduledStartAt + START_SPACING_MS, gatewayQuietUntil());
          if (now < earliest) {
            store.update(wf.id, {
              schedule: { ...schedule, nextRunAt: earliest + Math.round(Math.random() * 10_000) },
            });
            continue;
          }
          lastScheduledStartAt = now;
          const nextAt = now + jitter(interval);

          // Re-arm FIRST so a slow start can never double-fire on the next tick
          store.update(wf.id, {
            schedule: { ...schedule, lastRunAt: now, nextRunAt: nextAt },
          });

          // r77: if this fire ends a deferral episode, stamp it — the audit
          // line under the workflow card then reads "deferred X — fired Y".
          closeScheduleDeferral(wf.id, now);

          toast(`Scheduled run started`, {
            icon: "⏰",
            description: `${wf.name} · every ${Math.round(interval / 60_000)}m`,
          });

          void executeWorkflowRun({
            workflow: { id: wf.id },
            task,
            source: "scheduled",
          }).catch(() => {
            /* runner already surfaces step errors in the run row + toasts */
          });
        }
      } finally {
        ticking = false;
      }
    };

    tick(); // catch any schedule that came due while unmounted
    const t = setInterval(tick, TICK_MS);
    return () => clearInterval(t);
  }, []);

  return null;
}
