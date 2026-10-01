/**
 * r178 — Park-and-resume policy, extracted pure (no browser/store deps).
 *
 * r158 established the doctrine for rate-limit deaths: a saturated gateway is
 * CONGESTION, not breakage — while park budget remains, a failed step parks
 * the run ("error" + recovery card, honestly) and a long-delay auto-resume
 * brings it back once the window has passed. The user's Continuous-Research
 * run that died at "Error: network error" (r177 report) proved the SAME
 * doctrine applies to transient network/timeout deaths: the in-engine
 * self-heal ladder (r19: two clean retries) and the r177 in-tool retry ladder
 * both outlive only seconds-long blips — a minutes-long dead window exhausts
 * them, the step dies, and the run sat there waiting for a human.
 *
 * Two budgets, deliberately separate (same reasoning as r158's "dedicated
 * parkCount, NOT resumeCount"):
 *  - rate-limit parks (r158): 5m → 10m → 20m → 30m (4 parks, 65m total) —
 *    sized to outlive a full hourly gateway congestion wave.
 *  - network parks (r178): 2m → 4m → 8m (3 parks, 14m total) — blips and
 *    router hiccups are shorter than quota windows; a network that is still
 *    dead after 14 minutes of honest waiting deserves a human, not a 12th
 *    silent retry. Each delay is ±20% jittered (gateway-cadence) so parked
 *    runs never re-dial in lockstep with the wave they're hiding from.
 *
 * The stall watchdog path (r72) is EXEMPT: it carries its own bounded
 * resume budget (MAX_AUTO_RESUMES) and schedules its own resume — parking
 * there too would double-schedule and silently spend network budget.
 */
import { jitteredBackoff } from "@/lib/gateway-cadence";

export type ParkKind = "rate-limit" | "network";

export const MAX_RATE_LIMIT_PARKS = 4;
export const MAX_NETWORK_PARKS = 3;

const RATE_LIMIT_BASE_MS = 5 * 60_000;
const RATE_LIMIT_CAP_MS = 30 * 60_000;
const NETWORK_BASE_MS = 2 * 60_000;
const NETWORK_CAP_MS = 10 * 60_000;

/** Escalating, jittered park wait for the Nth park (0-based) of `kind`. */
export function parkDelayMs(kind: ParkKind, parkIndex: number): number {
  const base = kind === "network" ? NETWORK_BASE_MS : RATE_LIMIT_BASE_MS;
  const cap = kind === "network" ? NETWORK_CAP_MS : RATE_LIMIT_CAP_MS;
  return jitteredBackoff(Math.min(base * 2 ** parkIndex, cap));
}

/** Total park budget for `kind`. */
export function maxParks(kind: ParkKind): number {
  return kind === "network" ? MAX_NETWORK_PARKS : MAX_RATE_LIMIT_PARKS;
}

/**
 * Which park (if any) a failed step should get. `errorKind` is a
 * classifyRunError kind; parkable classes are the transient ones only —
 * auth/model/region-block/unknown failures are real breakage and go
 * straight to the recovery card. `stallOwned` exempts the r72 watchdog
 * path (it resumes itself). Returns the park kind, or null = no park.
 */
export function resolvePark(
  errorKind: string,
  counts: { parkCount?: number; netParkCount?: number },
  opts?: { stallOwned?: boolean }
): ParkKind | null {
  if (errorKind === "rate-limit") {
    return (counts.parkCount ?? 0) < MAX_RATE_LIMIT_PARKS ? "rate-limit" : null;
  }
  if ((errorKind === "network" || errorKind === "timeout") && !opts?.stallOwned) {
    return (counts.netParkCount ?? 0) < MAX_NETWORK_PARKS ? "network" : null;
  }
  return null;
}
