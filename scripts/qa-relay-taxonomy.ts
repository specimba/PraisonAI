// r187 QA — relay failure taxonomy: soft / hard / dead classification,
// cooldown windowing, provider-wide auth stamping, badge surfacing.
// Run: bun run scripts/qa-relay-taxonomy.ts

import {
  isSoftRelayFailure,
  isDeadlyRelayFailure,
  isHardRelayFailure,
  relayHopBadge,
  type RelayHealthEntry,
} from "../src/lib/relay";
import * as fs from "node:fs";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => {
  console.log(`  ${c ? "✓" : "✗"} ${m}`);
  if (c) pass++; else fail++;
};
const relaySrc = fs.readFileSync("src/lib/relay.ts", "utf8");

console.log("K1 — SOFT: capacity noise never demotes, never dead");
for (const e of [
  "API request failed with status 429: too many requests",
  "Rate limit exceeded. Please wait before sending more requests.",
  "Too many requests. Please slow down and try again shortly.",
  "quota exceeded for this model",
  "status 408 request timeout",
]) {
  ok(isSoftRelayFailure(e), `soft: "${e.slice(0, 44)}"`);
  ok(!isDeadlyRelayFailure(e), `not dead: "${e.slice(0, 44)}"`);
  ok(!isHardRelayFailure(e), `not hard: "${e.slice(0, 44)}"`);
}

console.log("K2 — DEAD: the user's own paste (permanent rejections)");
const userPaste = [
  "This model requires lite tier or higher. Upgrade your account to access it.",
  "Access denied. This model is not available in your region.",
  "Authentication failed. Please check your API key and credentials.",
  "This model is currently in maintenance. Please try again later.",
];
for (const e of userPaste) {
  ok(isDeadlyRelayFailure(e), `dead: "${e.slice(0, 48)}"`);
  ok(isHardRelayFailure(e), `demotes: "${e.slice(0, 48)}"`);
  ok(!isSoftRelayFailure(e), `not soft: "${e.slice(0, 48)}"`);
}

console.log("K3 — HARD-but-not-dead: transient infra deaths stay short-cooldown");
for (const e of [
  "fetch failed",
  "socket connection terminated",
  "upstream stream error: The request timed out.",
  "API request failed with status 502",
  "",
]) {
  ok(isHardRelayFailure(e) || e === "status 408 request timeout", `hard: "${e || "(none)"}"`);
  ok(!isDeadlyRelayFailure(e), `not dead: "${e || "(none)"}"`);
}

console.log("K4 — r25 regression: the OLD regex classified 401/403 as soft; new one must not");
ok(/\b4(?:0\[13578\]|1\[02-9\])\b/.test(relaySrc) === false, "old 401-as-soft regex class is gone");
ok(isDeadlyRelayFailure("status 401 unauthorized") && isDeadlyRelayFailure("status 403 forbidden"), "401 + 403 are dead");

console.log("K5 — badge windowing: dead = blocked (6h), hard = sick (5m), soft = throttled");
const now = Date.now();
const mk = (p: Partial<RelayHealthEntry>): Record<string, RelayHealthEntry> => ({ "p::m": { ok: 0, fail: 1, ...p } as RelayHealthEntry });
ok(relayHopBadge("p", "m", mk({ lastFailAt: now - 10 * 60_000, soft: false, dead: true, lastError: "region" }))?.label === "blocked", "dead @10m → blocked (old window would have cleared it)");
ok(relayHopBadge("p", "m", mk({ lastFailAt: now - 10 * 60_000, soft: false }))?.label === "ok 0", "hard @10m → recovered (5m window)");
ok(relayHopBadge("p", "m", mk({ lastFailAt: now - 1_000, soft: true }))?.label === "throttled", "soft → throttled");
ok(relayHopBadge("p", "m", mk({ lastFailAt: now - 7 * 3600_000, dead: true }))?.label === "ok 0", "dead @7h → expired, back in chain");

console.log("K6 — source wiring: provider-wide auth stamping + success clears dead");
ok(/e\.dead = isDeadlyRelayFailure\(error\)/.test(relaySrc), "recordRelayHopResult stamps dead flag");
ok(/e\.dead = false; \/\/ r187/.test(relaySrc), "success clears the dead flag");
ok(/shared key rejected \(auth\)/.test(relaySrc) && /AUTH_RE\.test\(error\)/.test(relaySrc), "auth deaths stamp the whole provider family");
ok(/entry\.dead \? DEAD_COOLDOWN_MS : HEALTH_COOLDOWN_MS/.test(relaySrc), "recentlyFailed + badge both honor the 6h dead window");

console.log(`\nK-series (relay taxonomy): ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
