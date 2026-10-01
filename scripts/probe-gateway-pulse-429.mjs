#!/usr/bin/env node
// ─── r161 E2E probe: does a REAL server-side 429 land in the pulse? ─────────
// Relays one /api/chat dial at a public https endpoint that returns HTTP 429
// (httpbin.org, postman-echo fallback) — passes the SSRF guard by design —
// and asserts the full honest chain:
//   P1  SSE surfaces an error event classified kind:"rate-limit"
//   P2  db/gateway-pulse.json gains a recordGateway429("pulse-e2e-probe")
//   P3  GET /api/gateway/pulse reflects it (the read path the UI chip uses)

import fs from "node:fs";

const BASE = "http://localhost:3000";
const PULSE_FILE = "/home/z/my-project/db/gateway-pulse.json";
const MODEL = "pulse-e2e-probe";
const ENDPOINTS = [
  "https://httpbin.org/status/429",
  "https://postman-echo.com/status/429",
  "https://httpstat.us/429",
];

let passed = 0;
let failed = 0;
function check(name, ok, detail = "") {
  if (ok) passed += 1;
  else failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function dial429(baseUrl) {
  const res = await fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      provider: "custom",
      baseUrl,
      model: MODEL,
      messages: [{ role: "user", content: "probe" }],
      maxTokens: 16,
    }),
  });
  if (!res.ok || !res.body) return { sse: [], httpStatus: res.status };
  const text = await res.text();
  const sse = text
    .split("\n\n")
    .map((frame) => frame.replace(/^data: /, "").trim())
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line));
  return { sse, httpStatus: res.status };
}

async function main() {
  const before = JSON.parse(fs.readFileSync(PULSE_FILE, "utf8")).events.length;

  let outcome = null;
  for (const url of ENDPOINTS) {
    try {
      console.log(`dialing ${url} …`);
      outcome = await dial429(url);
      // Accept only a rate-limit verdict — other endpoints in the list may
      // 404/500 (httpbin's /status/429 served a 404 live, honestly classified
      // as kind=model); those prove the classifier but not the pulse hook.
      const hasRl = outcome.sse.some((e) => e.type === "error" && e.kind === "rate-limit");
      if (hasRl) break;
    } catch (e) {
      console.log(`  ${url} unreachable (${e.message}) — trying next`);
      outcome = null;
    }
  }
  if (!outcome) {
    console.error("All 429 endpoints unreachable — probe inconclusive, not a product failure");
    process.exit(2);
  }

  const errEvt = outcome.sse.find((e) => e.type === "error");
  check(
    "P1 SSE error classified rate-limit",
    !!errEvt && errEvt.kind === "rate-limit",
    errEvt ? `kind=${errEvt.kind} msg=${String(errEvt.message).slice(0, 90)}` : JSON.stringify(outcome.sse).slice(0, 200)
  );

  const record = JSON.parse(fs.readFileSync(PULSE_FILE, "utf8")).events;
  const gained = record.find((e) => e.model === MODEL);
  check(
    "P2 pulse file gained the probe's 429",
    !!gained && record.length === before + 1,
    gained ? `t=${new Date(gained.t).toISOString()}` : `events=${JSON.stringify(record)}`
  );

  const pulse = await (await fetch(`${BASE}/api/gateway/pulse`)).json();
  check(
    "P3 API reflects the probe's 429",
    pulse.last429At === gained?.t && pulse.count1h >= 1,
    JSON.stringify({ last429At: pulse.last429At, count1h: pulse.count1h })
  );

  console.log(`\nP-series: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error("PROBE ERROR:", e);
  process.exit(1);
});
