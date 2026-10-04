// ─── CDP QA — U-series (r242): What's-fixed receipt panel order ──────────────
// Feature under test: whats-fixed.tsx newest-first render + r239-r241 entries.
//  U1  first receipt chip = "r241", last = "r186", 13 entries total
//  U2  documented descending order (r240 before r239 before r237-r238 before r196)
//  U3  header names the new range r186-r241 and says "Newest receipts first"
//  U4  no console errors during the suite
// Static content — no store seeding, no reload dance required.
// Usage: node scripts/cdp-qa-whatsfixed-order.mjs [baseUrl]
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
const list = await fetch("http://127.0.0.1:9222/json/version").then((r) => r.json()).catch(() => null);
if (!list) { console.error("SUMMARY: 0 passed, 1 failed — chrome CDP not reachable"); process.exit(1); }
const targets = await fetch("http://127.0.0.1:9222/json/list").then((r) => r.json());
let page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
if (!page) { console.error("SUMMARY: 0 passed, 1 failed — no page target"); process.exit(1); }
const ws = await connect(page.webSocketDebuggerUrl);
await wsSend(ws, "Page.enable");
await wsSend(ws, "Runtime.enable");
// Desktop viewport — the sidebar nav only mounts in the desktop layout.
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
await waitFor(ws, `document.querySelector('#whats-fixed')`, 15_000);

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`  ${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
};

// U1 — order extremes + count
const u1 = await evalJs(ws, `(() => {
  const chips = [...document.querySelectorAll('#whats-fixed span[class*="bg-violet-500"]')].map((s) => s.textContent.trim());
  return { count: chips.length, first: chips[0] ?? null, last: chips[chips.length - 1] ?? null, chips };
})()`);
check("U1 first=r241 last=r186 count=13", u1.count === 13 && u1.first === "r241" && u1.last === "r186", JSON.stringify(u1));

// U2 — exact expected descending sequence (source array reversed)
const EXPECTED = "r241|r240|r239|r237-r238|r196|r195|r194|r193|r192|r190-r191|r189|r187-r188|r186";
const u2 = await evalJs(ws, `(() => {
  const chips = [...document.querySelectorAll('#whats-fixed span[class*="bg-violet-500"]')].map((s) => s.textContent.trim());
  return { sequence: chips.join("|") };
})()`);
check("U2 exact descending receipt sequence", u2.sequence === EXPECTED, JSON.stringify(u2));

// U3 — header names the new range + ordering promise (checked at section
// level: CardDescription may not render as a <p> in this shadcn version)
const u3 = await evalJs(ws, `(() => {
  const desc = document.querySelector('#whats-fixed')?.textContent ?? "";
  return { range: desc.includes("r186-r241"), newest: /newest receipts first/i.test(desc) };
})()`);
check("U3 header range r186-r241 + newest-first promise", u3.range && u3.newest, JSON.stringify(u3));

await shot(ws, "u-series-whatsfixed");

const errs = await evalJs(ws, `window.__errs ?? []`);
check("no console errors during suite", Array.isArray(errs) && errs.length === 0, JSON.stringify(errs ?? []).slice(0, 200));

const passed = results.filter((r) => r.ok).length;
console.log(`SUMMARY: ${passed} passed, ${results.length - passed} failed`);
process.exit(passed === results.length ? 0 : 1);
