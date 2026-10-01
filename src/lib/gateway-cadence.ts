// ─── v24: Gateway cadence (shared 429 politeness) ────────────────────────────
// The built-in engine and the user's BYOK providers both dial shared gateway
// aggregators whose rate limits are GLOBAL (proven live r109 + 2026-09-29:
// Deep 9-step + RSIinFIELD 5-step launching on the same second burst the
// free tier into 429s). Congestion is therefore SHARED FATE: when any run
// hits a 429, every scheduled START should pause briefly — not just the
// failing workflow's own retry ladder (v23 handles that per-step).

let quietUntil = 0;

/** Called by the workflow runner whenever a dial comes back 429/rate-limited. */
export function noteGateway429(): void {
  // 90s global quiet window — long enough for the congestion wave to pass,
  // short enough that a 30m schedule loses nothing. Re-hit refreshes it.
  quietUntil = Date.now() + 90_000;
}

/** Epoch ms until which scheduled STARTS should be deferred (0 = go). */
export function gatewayQuietUntil(): number {
  return quietUntil;
}

// ─── r181: pre-fire saturation gate (persistent signal, not the 90s window) ──
// Live evidence r180→r181 (user report "what is the problem again?"): the
// hourly Continuous-Research Deep pipeline went 12 runs / 24h with ZERO done,
// 8 of 12 dead at the same step ("Deep research pass 2"), and gateway 429s
// spanning an hour (57m → 40m → 7m ago — 17 in 24h). The v24 quiet window is
// only 90s of in-memory politeness: it re-opens straight into the same
// congestion wave, and the r171 breaker only reacts AFTER 3 doomed runs have
// each burned step-1 quota (~150s + 7 tool calls) before dying at step 2.
// Fix: a scheduled START now also consults the server's PERSISTENT 429 ring
// (gateway-pulse, the same signal feeding the header chip) and defers while
// the wave is active. Zero cost: no run, no step-1 burn, no red history row —
// the fire lands on the first tick after the wave passes.
export const SATURATION_RECENT_MS = 10 * 60_000; // a 429 within 10m = active wave
export const SATURATION_MIN_1H = 3; // and ≥3 in the past hour — lone blips never stall schedules

export interface SaturationSignal {
  last429At: number | null;
  count1h: number;
}

export function gatewaySaturated(
  sig: SaturationSignal,
  now: number = Date.now()
): boolean {
  if (sig.last429At == null) return false;
  return now - sig.last429At < SATURATION_RECENT_MS && sig.count1h >= SATURATION_MIN_1H;
}

/** Derive a signal from raw pulse events (the db/gateway-pulse.json shape) —
 * lets the headless mini-service (own file read) and QA share the exact
 * semantics with the in-tab scheduler (fetch-shaped signal). */
export function gatewaySaturatedFromEvents(
  events: { t: number }[],
  now: number = Date.now()
): boolean {
  const valid = events.filter((e) => typeof e?.t === "number");
  const last = valid.length ? valid[valid.length - 1].t : null;
  const count1h = valid.filter((e) => now - e.t < 3_600_000).length;
  return gatewaySaturated({ last429At: last, count1h }, now);
}

// ─── r171: congestion auto-resume ladder (user report: "job stopping itself") ─
// The r156 breaker disables a schedule after 2 consecutive rate-limit failures
// and leaves it OFF until a human clicks resume. For a shared free gateway
// that saturates in waves (pulse: 10×429 in 24h, all hourly-cron collinear),
// that converts a transient congestion window into a LOST pipeline. New
// doctrine: congestion trips a SELF-HEALING backoff — the schedule re-arms
// itself after 45m → 1.5h → 3h → 6h (streak-exponential, capped). Only after
// 5 consecutive auto-resumed trips (≈ a full day of saturation) does it fall
// back to the honest manual pause — a persistent outage deserves a human.
export const RL_RESUME_BASE_MS = 45 * 60_000;
export const RL_RESUME_CAP_MS = 6 * 60 * 60_000;
export const MAX_AUTO_RESUME_TRIPS = 5;

/** Backoff until the auto-resume for a schedule whose breaker just tripped at `failStreak`. */
export function rateLimitResumeDelayMs(failStreak: number): number {
  return Math.min(
    RL_RESUME_BASE_MS * 2 ** Math.max(0, failStreak - 2),
    RL_RESUME_CAP_MS
  );
}

/** ±20% jitter — desynchronizes re-fires from the global on-the-hour cron wave. */
export function jitteredBackoff(ms: number): number {
  return Math.round(ms * (0.9 + Math.random() * 0.2));
}
