#!/usr/bin/env node
// ─── AG-series (r250): API route error-handling guards ──────────────────────
// Standing static guard encoding the r250 full-sweep invariants. The r250
// sweep audited ALL 19 route files and found the surface fully hardened
// (JSON errors with real status codes, upstream timeout signals, no stack
// leaks) — this script pins those properties so future routes cannot
// silently regress them. Static analysis only: no server needed.
//
//  G1  every route.ts handler file is error-guarded: contains a try/catch,
//      OR is explicitly allowlisted below WITH a reason string.
//  G2  no 200-with-error-body: NextResponse.json({...error...}) with NO
//      status argument (the classic "200 OK but it failed" regression).
//  G3  no stack leaks: error responses carry messages, never `.stack`.
//  G4  every upstream `await fetch(` in a route carries an abort `signal`
//      within the following 10 lines (the established AbortSignal.timeout
//      pattern — a missing signal can hang a route open indefinitely).
//
// SELFTEST: `--selftest` runs every detector against embedded BAD samples
// and asserts each one fires (plus a GOOD sample that must stay clean) —
// so the guard itself cannot rot into tautology.
//
// Usage:
//   node scripts/qa-api-error-guards.mjs            # audit the real tree
//   node scripts/qa-api-error-guards.mjs --selftest # detector self-test
import fs from "node:fs";
import path from "node:path";

const API_DIR = path.resolve("src/app/api");

// G1 allowlist — every entry MUST carry a human reason.
const TRYLESS_ALLOWLIST = new Map([
  ["gateway/pulse/route.ts", "pure sync read of the in-memory gateway-pulse ring (gatewayPulse() cannot reject)"],
]);

function routeFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...routeFiles(p));
    else if (e.name === "route.ts") out.push(p);
  }
  return out;
}

// ─── Detectors (pure text-in → findings-out, unit-testable) ─────────────────

/** G1: file has no try/catch anywhere. */
export function detectTryless(text, rel) {
  if (TRYLESS_ALLOWLIST.has(rel)) return [];
  if (/try\s*\{/.test(text)) return [];
  return [{ guard: "G1", msg: "no try/catch in route handlers" }];
}

/** G2: NextResponse.json(<obj containing `error`>) with NO second argument. */
export function detect200WithError(text) {
  const out = [];
  const re = /NextResponse\.json\(\s*\{[^{}]*\berror\b[^{}]*\}\s*\)/g;
  let m;
  while ((m = re.exec(text))) out.push({ guard: "G2", msg: `200-with-error-body: ${m[0].slice(0, 80)}…` });
  return out;
}

/** G3: `.stack` reaching a response payload. */
export function detectStackLeak(text) {
  const out = [];
  const re = /NextResponse\.json\(\s*\{[^{}]*\.stack/g;
  let m;
  while ((m = re.exec(text))) out.push({ guard: "G3", msg: "stack leaked into error response" });
  return out;
}

/** G4: `await fetch(` without `signal` in the following 10 lines. */
export function detectFetchWithoutSignal(text) {
  const out = [];
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    if (!/await\s+fetch\(/.test(line)) return;
    const window = lines.slice(i, i + 11).join("\n");
    if (!/\bsignal\s*:/.test(window)) {
      out.push({ guard: "G4", msg: `upstream fetch without abort signal at line ${i + 1}` });
    }
  });
  return out;
}

const DETECTORS = [detectTryless, detect200WithError, detectStackLeak, detectFetchWithoutSignal];

// ─── Selftest: bad samples MUST trip, good sample MUST stay clean ───────────
const BAD_SAMPLES = [
  { code: `export async function GET() {\n  return NextResponse.json({ error: "boom" });\n}`, expect: "G2" },
  { code: `export async function GET() {\n  return NextResponse.json({ error: err.stack }, { status: 500 });\n}`, expect: "G3" },
  { code: `export async function GET() {\n  const r = await fetch("https://x.example", { method: "GET" });\n  return NextResponse.json({ ok: true });\n}`, expect: "G4" },
  { code: `export async function GET() {\n  const data = await expensiveThing();\n  return NextResponse.json(data);\n}`, expect: "G1" },
];
const GOOD_SAMPLE = `export async function GET() {
  try {
    const r = await fetch("https://x.example", { signal: AbortSignal.timeout(5_000) });
    if (!r.ok) return NextResponse.json({ error: "upstream failed" }, { status: 502 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "failed" }, { status: 500 });
  }
}`;

function runSelftest() {
  let pass = 0;
  const total = BAD_SAMPLES.length + 1;
  for (const s of BAD_SAMPLES) {
    const fired = DETECTORS.some((d) => d(s.code, "selftest/route.ts").some((f) => f.guard === s.expect));
    console.log(`${fired ? "✅" : "❌"} selftest: ${s.expect} detector fires on bad sample`);
    if (fired) pass++;
  }
  const clean = DETECTORS.every((d) => d(GOOD_SAMPLE, "selftest/route.ts").length === 0);
  console.log(`${clean ? "✅" : "❌"} selftest: good sample stays clean`);
  if (clean) pass++;
  console.log(`SELFTEST SUMMARY: ${pass} passed, ${total - pass} failed`);
  process.exit(pass === total ? 0 : 1);
}

// ─── Main audit ──────────────────────────────────────────────────────────────
function main() {
  if (process.argv.includes("--selftest")) return runSelftest();
  const files = routeFiles(API_DIR);
  let findings = 0;
  for (const f of files) {
    const rel = path.relative(API_DIR, f).split(path.sep).join("/");
    const text = fs.readFileSync(f, "utf8");
    for (const d of DETECTORS) {
      for (const hit of d(text, rel)) {
        findings++;
        console.log(`❌ [${hit.guard}] ${rel} — ${hit.msg}`);
      }
    }
  }
  const allow = [...TRYLESS_ALLOWLIST.keys()].filter((k) => files.some((f) => path.relative(API_DIR, f).split(path.sep).join("/").endsWith(k)));
  console.log(`audited ${files.length} route files · allowlisted tryless: ${allow.length ? allow.join(", ") : "none"}`);
  console.log(`SUMMARY: ${findings === 0 ? "ALL CLEAN" : `${findings} finding(s)`}`);
  process.exit(findings === 0 ? 0 : 1);
}

main();
