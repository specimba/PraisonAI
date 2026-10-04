// ─── CDP QA — R-series (r240): radar tab-state persistence ───────────────────
// Feature under test: HF Hub-section choice and the Papers query survive
// view switches (previously both snapped back on remount).
//  R1  HF: click "Datasets" → switch to Chat → back to Radar → still Datasets
//  R2  the HF kind key is persisted in localStorage ("datasets")
//  R3  Papers: type a custom query (no search) → switch views → back →
//      the input still shows the typed text
// Tab doctrine (r160 correction): Radix activates tabs on POINTERDOWN — a
// synthetic .click() silently switches nothing. Dispatch the full sequence.
// Usage: node scripts/cdp-qa-radar-persist.mjs [baseUrl]
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

const NAV = (label) => `(() => {
  const btns = [...document.querySelectorAll('nav[aria-label="Primary"] button')];
  const b = btns.find((x) => x.textContent.includes(${JSON.stringify(label)}));
  if (!b) return false;
  b.click(); return true;
})()`;
// r160-proven Radix tab switch: pointerdown first, or nothing happens.
const clickTab = (label) => evalJs(ws, `(() => {
  const t = [...document.querySelectorAll('[role="tab"]')].find((x) => (x.textContent ?? "").includes(${JSON.stringify(label)}));
  if (!t) return false;
  t.focus();
  t.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  t.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  t.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  return true;
})()`);
const TYPE_INTO = (sel, v) => `(() => {
  const el = document.querySelector(${JSON.stringify(sel)});
  if (!el) return false;
  const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  set.call(el, ${JSON.stringify(v)});
  el.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
})()`;

const list = await fetch("http://127.0.0.1:9222/json/version").then((r) => r.json()).catch(() => null);
if (!list) { console.error("SUMMARY: 0 passed, 1 failed — chrome CDP not reachable"); process.exit(1); }
const targets = await fetch("http://127.0.0.1:9222/json/list").then((r) => r.json());
const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
if (!page) { console.error("SUMMARY: 0 passed, 1 failed — no page target"); process.exit(1); }
const ws = await connect(page.webSocketDebuggerUrl);
await wsSend(ws, "Page.enable");
await wsSend(ws, "Runtime.enable");
await wsSend(ws, "Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

await wsSend(ws, "Page.navigate", { url: BASE });
await waitFor(ws, `document.readyState === "complete"`, 60_000);
await waitFor(ws, `document.querySelector('nav[aria-label="Primary"]')`, 45_000);
await evalJs(ws, `localStorage.removeItem("praison-radar-hf-kind")`);

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`  ${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
};
const openRadarHF = async () => {
  await evalJs(ws, NAV("Radar"));
  await waitFor(ws, `document.querySelector('[role="tablist"][aria-label="Trend radar sections"]')`, 15_000);
  await clickTab("HF Trending");
  await waitFor(ws, `document.querySelector('[role="radiogroup"][aria-label="Hub section"]')`, 15_000);
};

// R1 — HF kind survives a round trip
await openRadarHF();
const clicked = await evalJs(ws, `(() => {
  const btns = [...document.querySelectorAll('[role="radiogroup"][aria-label="Hub section"] button')];
  const b = btns.find((x) => x.textContent.includes("Datasets"));
  if (!b) return false;
  b.focus();
  b.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  b.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  return true;
})()`);
await waitFor(ws, `(() => { const b=[...document.querySelectorAll('[role="radiogroup"][aria-label="Hub section"] button')].find(x=>x.textContent.includes("Datasets")); return b && b.getAttribute("aria-checked")==="true"; })()`, 5_000);
await evalJs(ws, NAV("Chat"));
await waitFor(ws, `document.querySelector('nav[aria-label="Primary"]') && !document.querySelector('[role="tablist"][aria-label="Trend radar sections"]')`, 10_000);
await openRadarHF();
const r1 = await evalJs(ws, `(() => {
  const b = [...document.querySelectorAll('[role="radiogroup"][aria-label="Hub section"] button')].find(x => x.textContent.includes("Datasets"));
  return { checked: b?.getAttribute("aria-checked") ?? "?" };
})()`);
check("R1 HF 'Datasets' survives view switch + remount", clicked && r1.checked === "true", `clicked=${clicked} aria-checked=${r1.checked}`);

// R2 — persisted key
const r2 = await evalJs(ws, `localStorage.getItem("praison-radar-hf-kind")`);
check("R2 kind key persisted in localStorage", r2 === '"datasets"', `value=${JSON.stringify(r2)}`);

// R3 — papers query typed-but-unsearched survives
await clickTab("Paper Radar");
await waitFor(ws, `document.querySelector('input[aria-label="arXiv query"]')`, 15_000);
const typed = await evalJs(ws, TYPE_INTO('input[aria-label="arXiv query"]', "galaxy evolution survey r240"));
await evalJs(ws, NAV("Chat"));
await waitFor(ws, `!document.querySelector('input[aria-label="arXiv query"]')`, 10_000);
await evalJs(ws, NAV("Radar"));
await waitFor(ws, `document.querySelector('[role="tablist"][aria-label="Trend radar sections"]')`, 15_000);
await clickTab("Paper Radar");
await waitFor(ws, `(() => { const el = document.querySelector('input[aria-label="arXiv query"]'); return el && el.value.includes("r240"); })()`, 8_000);
const r3 = await evalJs(ws, `(() => {
  const el = document.querySelector('input[aria-label="arXiv query"]');
  return { value: el?.value ?? "?" };
})()`);
check("R3 typed-but-unsearched Papers query survives", typed && r3.value.includes("r240"), `typed=${typed} value="${r3.value.slice(0, 60)}"`);

await shot(ws, "r-series-radar-persist");
const passed = results.filter((r) => r.ok).length;
console.log(`SUMMARY: ${passed} passed, ${results.length - passed} failed`);
process.exit(passed === results.length ? 0 : 1);
