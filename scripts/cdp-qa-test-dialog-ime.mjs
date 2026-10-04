import { ensureChrome } from "./cdp-ensure-chrome.mjs";
// ─── CDP QA — W-series (r244): test playground IME-safe Enter ────────────────
// Feature under test: test-agent-dialog Enter-to-send now ignores Enter that
// only confirms an IME composition (parity with the chat composer).
//  W1  keydown Enter with isComposing=true does NOT send (no user bubble,
//      input keeps its value, not running)
//  W2  plain Enter DOES send: user bubble appears + input cleared
//  W3  the turn settles (stop button disappears / retry or error state
//      reachable) without a provider — no hang
//  W4  no console errors during the suite
// Seeding doctrine: boot → sleep 700 → seed → sleep 700 → re-seed → reload
// (debouncedStorage 450ms; fresh profiles need the blob CREATED at the app's
// default version — agents persist has used version 1).
// Usage: node scripts/cdp-qa-test-dialog-ime.mjs [baseUrl]
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

// ─── seed material: collision-immune tokens (v244) ──────────────────────────
const NOW = Date.now();
const AGENT = {
  id: "w244-pilot", name: "Playground Pilot v244", emoji: "🛩️", color: "violet",
  role: "Test bench bot", description: "Test bench bot", instructions: "test",
  model: "auto", temperature: 0.4, maxIterations: 4, tools: [],
  createdAt: NOW, updatedAt: NOW,
};
const AGENT_NAME = "Playground Pilot v244";
const SEED = `
  (() => {
    const key = Object.keys(localStorage).find((k) => /agent/i.test(k));
    const mine = ${JSON.stringify(AGENT)};
    if (!key) {
      localStorage.setItem("praison-agents", JSON.stringify({ state: { agents: [mine] }, version: 1 }));
      return { ok: true, total: 1 };
    }
    const blob = JSON.parse(localStorage.getItem(key) || "{}");
    const list = Array.isArray(blob?.state?.agents) ? blob.state.agents : [];
    const cleaned = list.filter((a) => a.id !== mine.id);
    localStorage.setItem(key, JSON.stringify({ state: { agents: [...cleaned, mine] }, version: blob.version ?? 1 }));
    return { ok: true, total: cleaned.length + 1 };
  })()
`;
const TYPE_INTO = (v) => `
  (() => {
    const el = document.querySelector('textarea[aria-label="Test message"]');
    if (!el) return false;
    const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
    set.call(el, ${JSON.stringify(v)});
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()
`;

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

// Debounce dance: wait out the boot-time store flush, seed, wait again, re-seed
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(700);
let seeded = await evalJs(ws, SEED);
if (!seeded?.ok) { console.error("SUMMARY: 0 passed, 1 failed — seed failed:", JSON.stringify(seeded)); process.exit(1); }
await sleep(700);
seeded = await evalJs(ws, SEED);
console.log(`  🌱 seeded — agents total: ${seeded.total}`);
await wsSend(ws, "Page.reload", { ignoreCache: true });
await waitFor(ws, `document.readyState === "complete"`, 60_000);
await waitFor(ws, `document.querySelector('nav[aria-label="Primary"]')`, 45_000);
await evalJs(ws, `
  window.__errs = [];
  window.addEventListener("error", (e) => window.__errs.push(String(e.message)));
  window.addEventListener("unhandledrejection", (e) => window.__errs.push(String(e.reason?.message ?? e.reason)));
`);

// open the Agents view
let opened = false;
for (let i = 0; i < 25 && !opened; i++) {
  opened = await evalJs(ws, `(() => {
    const btns = [...document.querySelectorAll('nav[aria-label="Primary"] button')];
    const b = btns.find((x) => x.textContent.includes("Agents"));
    if (!b) return false;
    b.click(); return true;
  })()`);
  if (!opened) await new Promise((r) => setTimeout(r, 400));
}
if (!opened) { console.error("SUMMARY: 0 passed, 1 failed — Agents nav button not found"); process.exit(1); }
await waitFor(ws, `document.querySelector('[role="button"][aria-label="Open test playground for ${AGENT_NAME}"]')`, 15_000);
// DIAG — why might the trigger be missing?
const diag = await evalJs(ws, `(() => {
  const cards = [...document.querySelectorAll('main [data-agent-card], main h3')].length;
  const triggers = [...document.querySelectorAll('button[aria-label^="Open test playground"]')].map((b) => b.getAttribute("aria-label"));
  let ids = [];
  try {
    const blob = JSON.parse(localStorage.getItem("praison-agents") || "{}");
    ids = (blob?.state?.agents ?? []).map((a) => a.id);
  } catch (e) { ids = ["parse-error"]; }
  return { cards, triggers: triggers.slice(0, 6), triggerCount: triggers.length, agentIds: ids, bodyLen: document.body.textContent.length };
})()`);
console.error("  DIAG:", JSON.stringify(diag));

// open the test playground dialog
await evalJs(ws, `document.querySelector('[role="button"][aria-label="Open test playground for ${AGENT_NAME}"]')?.click()`);
const dialogOpen = await waitFor(ws, `document.querySelector('textarea[aria-label="Test message"]')`, 10_000);
if (!dialogOpen) {
  const d2 = await evalJs(ws, `({ dialogs: document.querySelectorAll('[role="dialog"]').length, bodyLen: document.body.textContent.slice(0, 300) })`);
  console.error("dialog did not open — diag:", JSON.stringify(d2));
  console.error("SUMMARY: 0 passed, 1 failed — test playground dialog did not open");
  process.exit(1);
}

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`  ${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
};

// W1 — IME-composing Enter must NOT send
await evalJs(ws, TYPE_INTO("v244 IME check 你好"));
await evalJs(ws, `(() => {
  const el = document.querySelector('textarea[aria-label="Test message"]');
  el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, isComposing: true }));
  return true;
})()`);
await sleep(600);
const w1 = await evalJs(ws, `(() => {
  const dialog = document.querySelector('[role="dialog"]');
  const bubbles = dialog ? [...dialog.querySelectorAll(".ml-auto")].filter((d) => d.textContent.includes("v244 IME check")) : [];
  const ta = document.querySelector('textarea[aria-label="Test message"]');
  return {
    userBubbles: bubbles.length,
    kept: ta?.value ?? "",
    running: Boolean(document.querySelector('button[aria-label="Stop run"]')),
  };
})()`);
check("W1 composing-Enter does not send", w1.userBubbles === 0 && w1.kept.includes("v244 IME check") && !w1.running, JSON.stringify(w1));

// W2 — plain Enter sends
await evalJs(ws, `(() => {
  const el = document.querySelector('textarea[aria-label="Test message"]');
  el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  return true;
})()`);
await waitFor(ws, `(() => {
  const dialog = document.querySelector('[role="dialog"]');
  return Boolean(dialog && [...dialog.querySelectorAll(".ml-auto")].some((d) => d.textContent.includes("v244 IME check")));
})()`, 8_000);
const w2 = await evalJs(ws, `(() => {
  const dialog = document.querySelector('[role="dialog"]');
  const bubbles = dialog ? [...dialog.querySelectorAll(".ml-auto")].filter((d) => d.textContent.includes("v244 IME check")) : [];
  const ta = document.querySelector('textarea[aria-label="Test message"]');
  return {
    userBubbles: bubbles.length,
    cleared: (ta?.value ?? "x") === "",
    assistantBubble: Boolean(dialog?.querySelector(".rounded-2xl.border")),
  };
})()`);
check("W2 plain Enter sends (bubble + composer cleared)", w2.userBubbles === 1 && w2.cleared && w2.assistantBubble, JSON.stringify(w2));

// W3 — the turn settles without a provider (no hang): stop if still running,
// then wait for a terminal state (stopped marker, retry button or error text)
const stopBtn = await evalJs(ws, `Boolean(document.querySelector('button[aria-label="Stop run"]'))`);
if (stopBtn) {
  await evalJs(ws, `document.querySelector('button[aria-label="Stop run"]')?.click()`);
}
const settled = await waitFor(ws, `(() => {
  const dialog = document.querySelector('[role="dialog"]');
  if (!dialog) return false;
  const t = dialog.textContent;
  return Boolean(document.querySelector('button[aria-label="Stop run"]') === null &&
    (/\\(stopped\\)/.test(t) || document.querySelector('button[aria-label="Retry this message"]') || /error/i.test(t)));
})()`, 20_000);
check("W3 turn settles without a provider (no hang)", settled, `stopBtnAtTurn=${stopBtn}`);

await shot(ws, "w-series-test-dialog-ime");

const errs = await evalJs(ws, `window.__errs ?? []`);
check("no console errors during suite", Array.isArray(errs) && errs.length === 0, JSON.stringify(errs ?? []).slice(0, 200));

const passed = results.filter((r) => r.ok).length;
console.log(`SUMMARY: ${passed} passed, ${results.length - passed} failed`);
process.exit(passed === results.length ? 0 : 1);
