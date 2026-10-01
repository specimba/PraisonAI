// r171 QA — pure-logic ladder tests for the congestion auto-resume (G-series).
// gateway-cadence.ts is dependency-free, so bun runs these without a browser.
import {
  rateLimitResumeDelayMs,
  jitteredBackoff,
  RL_RESUME_BASE_MS,
  RL_RESUME_CAP_MS,
  MAX_AUTO_RESUME_TRIPS,
} from "../src/lib/gateway-cadence";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

console.log("G1 — ladder growth (streak-exponential, capped):");
const d2 = rateLimitResumeDelayMs(2);
const d3 = rateLimitResumeDelayMs(3);
const d4 = rateLimitResumeDelayMs(4);
const d5 = rateLimitResumeDelayMs(5);
const d9 = rateLimitResumeDelayMs(9);
check(`trip at streak 2 = 45m (got ${d2 / 60_000}m)`, d2 === RL_RESUME_BASE_MS);
check(`streak 3 = 1.5h (got ${d3 / 60_000}m)`, d3 === 1.5 * 3_600_000);
check(`streak 4 = 3h (got ${d4 / 3_600_000}h)`, d4 === 3 * 3_600_000);
check(`streak 5 = 6h (got ${d5 / 3_600_000}h)`, d5 === RL_RESUME_CAP_MS);
check(`streak 9 clamped at 6h (got ${d9 / 3_600_000}h)`, d9 === RL_RESUME_CAP_MS);
check(
  "monotonic non-decreasing across streaks 0..8",
  [0, 1, 2, 3, 4, 5, 6, 7, 8]
    .map(rateLimitResumeDelayMs)
    .every((v, i, a) => i === 0 || v >= a[i - 1])
);

console.log("G2 — jitter envelope (±20%):");
let inside = 0;
for (let i = 0; i < 500; i++) {
  const j = jitteredBackoff(1_000_000);
  if (j >= 900_000 && j <= 1_200_000) inside++;
}
check("500 samples all within [0.9x, 1.2x]", inside === 500, `${inside}/500`);
check("returns integer ms", Number.isInteger(jitteredBackoff(1_234_567)));

console.log("G3 — constants coherent:");
check(`MAX_AUTO_RESUME_TRIPS = 5 (got ${MAX_AUTO_RESUME_TRIPS})`, MAX_AUTO_RESUME_TRIPS === 5);
check("cap 6h > base 45m", RL_RESUME_CAP_MS > RL_RESUME_BASE_MS);
// Full-day saturation budget: trips 1..5 = 45m + 1.5h + 3h + 6h + 6h = 17h
const totalWait =
  rateLimitResumeDelayMs(2) +
  rateLimitResumeDelayMs(3) +
  rateLimitResumeDelayMs(4) +
  rateLimitResumeDelayMs(5) +
  rateLimitResumeDelayMs(6);
check(
  `5 trips cover ~17h of backoff before manual pause (got ${(totalWait / 3_600_000).toFixed(1)}h)`,
  totalWait >= 16 * 3_600_000
);

console.log(`\nG-series: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
