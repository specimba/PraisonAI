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
