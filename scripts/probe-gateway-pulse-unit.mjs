#!/usr/bin/env node
// ─── r161 unit probe: recordGateway429 → file → gatewayPulse chain ──────────
// The public-internet 429 simulators are unreachable from this sandbox
// (egress-restricted), so the route-catch→classify link stays proven by the
// live P1 observation (a real relayed 404 surfaced kind="model" through the
// same catch→classify→SSE path). THIS probe proves the remaining link
// honestly and in isolation: recordGateway429() appends, persists, prunes
// and reads back exactly what the API route and UI chip consume.
// gateway-pulse.ts imports only node:fs/node:path — type-stripped by node 24.
//
// IMPORTANT: ends by RESETTING db/gateway-pulse.json to empty so the user's
// chip starts on truthful data (the QA seeds are synthetic and must not
// masquerade as observed congestion).

import fs from "node:fs";
import { pathToFileURL } from "node:url";

const PULSE_FILE = "/home/z/my-project/db/gateway-pulse.json";
const MOD = "/home/z/my-project/src/lib/server/gateway-pulse.ts";

let passed = 0;
let failed = 0;
function check(name, ok, detail = "") {
  if (ok) passed += 1;
  else failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const mod = await import(pathToFileURL(MOD).href);

// U1: record → visible in the same process's read path
fs.writeFileSync(PULSE_FILE, JSON.stringify({ events: [] }), "utf8");
mod.recordGateway429("unit-probe-a");
mod.recordGateway429("unit-probe-b");
let pulse = mod.gatewayPulse();
check(
  "U1 two records → last429At + counts correct",
  pulse.count24h === 2 && pulse.count1h === 2 && pulse.recent.at(-1)?.model === "unit-probe-b",
  JSON.stringify({ count1h: pulse.count1h, count24h: pulse.count24h })
);

// U2: file-is-source-of-truth — an external rewrite is honored on next read
fs.writeFileSync(
  PULSE_FILE,
  JSON.stringify({ events: [{ t: Date.now() - 5 * 60_000, model: "external-seed" }] }),
  "utf8"
);
pulse = mod.gatewayPulse();
check(
  "U2 external file rewrite honored (no process-lifetime cache)",
  pulse.count24h === 1 && pulse.recent[0]?.model === "external-seed",
  JSON.stringify(pulse.recent)
);

// U3: a record after the external rewrite MERGES with it (write side re-syncs)
mod.recordGateway429("unit-probe-c");
pulse = mod.gatewayPulse();
check(
  "U3 record merges with externally-seeded state",
  pulse.count24h === 2 && pulse.recent.at(-1)?.model === "unit-probe-c",
  JSON.stringify(pulse.recent.map((e) => e.model))
);

// U4: >48h pruning keeps the file bounded
fs.writeFileSync(
  PULSE_FILE,
  JSON.stringify({
    events: [
      { t: Date.now() - 72 * 3_600_000, model: "ancient" },
      { t: Date.now() - 60_000, model: "fresh" },
    ],
  }),
  "utf8"
);
pulse = mod.gatewayPulse();
check(
  "U4 events older than 48h pruned on read",
  pulse.count24h === 1 && pulse.recent[0]?.model === "fresh",
  JSON.stringify(pulse.recent.map((e) => e.model))
);

// Reset to a TRUTHFUL empty record for the user (QA seeds are synthetic).
fs.writeFileSync(PULSE_FILE, JSON.stringify({ events: [] }), "utf8");
console.log("pulse record reset to empty (synthetic seeds must not masquerade as real congestion)");

console.log(`\nU-series: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
