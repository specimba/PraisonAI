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
