import { ensureChrome } from "./cdp-ensure-chrome.mjs";
// ─── CDP QA — V-series (r243): About panel build fingerprint ─────────────────
// Feature under test: BuildInfoLine in Settings → About decodes the r189
// /api/version freshness stamp into a human-readable build identity.
//  V1  build-info line renders with a boot id + "source last changed" text
//  V2  displayed boot id + mtime MATCH the live /api/version response
//      (mtime within 2h of now — src/ was just edited this round)
//  V3  no console errors during the suite
// Static content — no store seeding, no reload dance required.
// Usage: node scripts/cdp-qa-build-info.mjs [baseUrl]
import fs from "node:fs";
import path from "node:path";

const BASE = process.argv[2] ?? "http://localhost:3000";
const OUT_DIR = path.resolve("ops/qa");
fs.mkdirSync(OUT_DIR, { recursive: true });

let msgId = 0;
const pending = new Map();
function wsSend(ws, method, params = {}) {
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); } }, 20_000);
  });
}
async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("ws error")); });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
    }
  };
  return ws;
}
async function evalJs(ws, expression) {
  const r = await wsSend(ws, "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "eval error");
  return r.result?.value;
}
async function waitFor(ws, expr, timeoutMs = 15_000, everyMs = 400) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await evalJs(ws, `Boolean(${expr})`)) return true;
    await new Promise((r) => setTimeout(r, everyMs));
  }
  return false;
}
async function shot(ws, name) {
  const r = await wsSend(ws, "Page.captureScreenshot", { format: "png" });
  const file = path.join(OUT_DIR, `${name}.png`);
  fs.writeFileSync(file, Buffer.from(r.data, "base64"));
  console.log(`  📸 ${file}`);
}

// ─── drive ────────────────────────────────────────────────────────────────────
await ensureChrome();
const list = await fetch("http://127.0.0.1:9222/json/version").then((r) => r.json()).catch(() => null);
if (!list) { console.error("SUMMARY: 0 passed, 1 failed — chrome CDP not reachable"); process.exit(1); }
const targets = await fetch("http://127.0.0.1:9222/json/list").then((r) => r.json());
let page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
if (!page) { console.error("SUMMARY: 0 passed, 1 failed — no page target"); process.exit(1); }
const ws = await connect(page.webSocketDebuggerUrl);
await wsSend(ws, "Page.enable");
await wsSend(ws, "Runtime.enable");
await wsSend(ws, "Emulation.setDeviceMetricsOverride", {
  width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
});

await wsSend(ws, "Page.navigate", { url: BASE });
await waitFor(ws, `document.readyState === "complete"`, 60_000);
const navReady = await waitFor(ws, `document.querySelector('nav[aria-label="Primary"]')`, 45_000);
if (!navReady) {
  console.error("SUMMARY: 0 passed, 1 failed — app shell did not render");
  process.exit(1);
}
await evalJs(ws, `
  window.__errs = [];
  window.addEventListener("error", (e) => window.__errs.push(String(e.message)));
  window.addEventListener("unhandledrejection", (e) => window.__errs.push(String(e.reason?.message ?? e.reason)));
`);

// open Settings — poll the click: hydration can briefly unmount
let opened = false;
for (let i = 0; i < 25 && !opened; i++) {
  opened = await evalJs(ws, `(() => {
    const btns = [...document.querySelectorAll('nav[aria-label="Primary"] button')];
    const b = btns.find((x) => x.textContent.includes("Settings"));
    if (!b) return false;
    b.click(); return true;
  })()`);
  if (!opened) await new Promise((r) => setTimeout(r, 400));
}
if (!opened) { console.error("SUMMARY: 0 passed, 1 failed — Settings nav button not found"); process.exit(1); }

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`  ${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
};

// V1 — the build-info line renders
await waitFor(ws, `document.querySelector('[data-testid="build-info"]')`, 15_000);
const v1 = await evalJs(ws, `(() => {
  const el = document.querySelector('[data-testid="build-info"]');
  return {
    present: Boolean(el),
    text: el?.textContent ?? "",
    boot: el?.dataset.boot ?? "",
    changedMs: Number(el?.dataset.changedMs ?? 0),
  };
})()`);
check("V1 build-info renders (boot id + source-changed text)", v1.present && /^[0-9a-z]{4,10}$/.test(v1.boot) && /source last changed/i.test(v1.text), JSON.stringify(v1));

// V2 — the displayed values match the LIVE /api/version response
const v2 = await evalJs(ws, `(async () => {
  const res = await fetch("/api/version");
  if (!res.ok) return { ok: false, status: res.status };
  const data = await res.json();
  const [boot, mtime] = String(data.stamp ?? "").split(":");
  const el = document.querySelector('[data-testid="build-info"]');
  return {
    ok: true,
    apiBoot: boot ?? "",
    apiChangedMs: Number(mtime ?? 0),
    shownBoot: el?.dataset.boot ?? "",
    shownChangedMs: Number(el?.dataset.changedMs ?? 0),
    ageMinutes: Math.round((Date.now() - Number(mtime ?? 0)) / 60000),
  };
})()`);
const bootMatch = v2.ok && v2.apiBoot === v2.shownBoot;
const mtimeFresh = v2.ok && Math.abs(v2.shownChangedMs - v2.apiChangedMs) < 5_000 && v2.ageMinutes < 120;
check("V2 shown fingerprint matches live /api/version (mtime < 2h old)", bootMatch && mtimeFresh, JSON.stringify(v2));

await shot(ws, "v-series-build-info");

const errs = await evalJs(ws, `window.__errs ?? []`);
check("no console errors during suite", Array.isArray(errs) && errs.length === 0, JSON.stringify(errs ?? []).slice(0, 200));

const passed = results.filter((r) => r.ok).length;
console.log(`SUMMARY: ${passed} passed, ${results.length - passed} failed`);
process.exit(passed === results.length ? 0 : 1);
