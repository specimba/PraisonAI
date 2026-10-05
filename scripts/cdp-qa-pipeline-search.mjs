import { ensureChrome } from "./cdp-ensure-chrome.mjs";
// ─── CDP QA — S-series (r237): pipeline search in Workflow Studio ────────────
// Feature under test: the new search box in workflows-view.tsx.
//  T1  box renders with all cards visible (seeded + pre-existing)
//  T2  name needle "zephyr digest" → the uniquely-tokened seeded card
//  T3  instruction needle "quartz" → matches step instruction text
//  T4  agent-name needle "moss walker" → resolves agentId → name
//  T5  no-match needle → "No pipelines match" empty state; Clear restores all
//  T6  "/" hotkey focuses the box; live count text "1 of N pipelines"
// Seeding doctrine: the app's first-boot seeder owns 5 demo workflows and the
// persist blob's `version` advances with releases — a hardcoded version is
// silently ignored on rehydrate. So we boot first, read the LIVE persisted
// shape, APPEND our uniquely-tokened agents/workflows to it, then reload.
// Usage: node scripts/cdp-qa-pipeline-search.mjs [baseUrl]
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

// ─── seed material: uniquely tokened so pre-existing rosters can't collide ───
const NOW = Date.now();
const mkAgent = (id, name, emoji, role) => ({
  id, name, emoji, color: "violet", role, description: role, instructions: "test",
  model: "auto", temperature: 0.4, maxIterations: 4, tools: [],
  createdAt: NOW, updatedAt: NOW,
});
const AGENTS = [
  mkAgent("s237-aurora", "Aurora Beacon v237", "🌅", "Morning digest bot"),
  mkAgent("s237-quill", "Quill Keeper v237", "🧐", "Code review bot"),
  mkAgent("s237-moss", "Moss Walker v237", "🪴", "Garden planner bot"),
];
const mkWf = (id, name, desc, agentId, label, instruction, schedule) => ({
  id, name, description: desc,
  steps: [{ id: `${id}-step`, agentId, label, instruction, kind: "generate" }],
  runs: [], createdAt: NOW, updatedAt: NOW,
  ...(schedule ? { schedule } : {}),
});
const WFS = [
  mkWf("s237-wf-zephyr", "Zephyr Digest v237", "Morning headlines digest", "s237-aurora", "Scrape headlines", "pull top news",
    { enabled: false, intervalMs: 3_600_000, task: "kepler telemetry digest" }),
  mkWf("s237-wf-code", "Code Reviewer v237", "Reviews pull requests", "s237-quill", "Lint the diff", "check quartz typescript types"),
  mkWf("s237-wf-garden", "Garden Planner v237", "Seasonal planting plan", "s237-moss", "Watering schedule", "seasonal plants"),
];
// Adaptive seed: discover the real persist keys + versions on the LIVE origin,
// append ours, write back. Returns the expected total workflow count.
const APPEND_SEED = `
  (() => {
    const wfKey = Object.keys(localStorage).find((k) => /workflow/i.test(k));
    const agKey = Object.keys(localStorage).find((k) => /agent/i.test(k));
    const mine = ${JSON.stringify(WFS)};
    // Fresh profiles never wrote the persist key yet (debounced storage only
    // writes on change) — then we create the blob with the app's default
    // version: workflows config declares none → 0; agents blob has used 1.
    if (!wfKey) {
      localStorage.setItem("praison-workflows", JSON.stringify({ state: { workflows: mine, selectedId: null }, version: 0 }));
      if (!agKey) localStorage.setItem("praison-agents", JSON.stringify({ state: { agents: ${JSON.stringify(AGENTS)} }, version: 1 }));
      return { ok: true, total: mine.length };
    }
    const wfs = JSON.parse(localStorage.getItem(wfKey) || "{}");
    const before = Array.isArray(wfs?.state?.workflows) ? wfs.state.workflows : [];
    const cleaned = before.filter((w) => !mine.some((m) => m.id === w.id));
    localStorage.setItem(wfKey, JSON.stringify({ state: { workflows: [...cleaned, ...mine], selectedId: null }, version: wfs.version ?? 0 }));
    if (agKey) {
      const ags = JSON.parse(localStorage.getItem(agKey) || "{}");
      const list = Array.isArray(ags?.state?.agents) ? ags.state.agents : [];
      const keep = list.filter((a) => !${JSON.stringify(AGENTS.map((a) => a.id))}.includes(a.id));
      localStorage.setItem(agKey, JSON.stringify({ state: { agents: [...keep, ...${JSON.stringify(AGENTS)}] }, version: ags.version ?? 1 }));
    }
    return { ok: true, total: cleaned.length + mine.length };
  })()
`;
const TYPE_INTO = (v) => `
  (() => {
    const el = document.querySelector('input[aria-label="Search pipelines"]');
    if (!el) return false;
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    set.call(el, ${JSON.stringify(v)});
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()
`;

// ─── drive ────────────────────────────────────────────────────────────────────
await ensureChrome();
const list = await fetch("http://127.0.0.1:9222/json/version").then((r) => r.json()).catch(() => null);
if (!list) { console.error("SUMMARY: 0 passed, 1 failed — chrome CDP not reachable"); process.exit(1); }
// r266: self-created tab (scan-reuse was a race — clientless targets are
// reaped lazily by this shell; r265 finding).
const tabRes = await fetch("http://127.0.0.1:9222/json/new", { method: "PUT" });
if (!tabRes.ok) { console.error(`SUMMARY: 0 passed, 1 failed — /json/new failed: ${tabRes.status}`); process.exit(1); }
let page = await tabRes.json();
const ws = await connect(page.webSocketDebuggerUrl);
await wsSend(ws, "Page.enable");
await wsSend(ws, "Runtime.enable");
// Desktop viewport — the sidebar nav (and thus the Workflows button) only
// mounts in the desktop layout; the 800x600 default renders the mobile shell.
await wsSend(ws, "Emulation.setDeviceMetricsOverride", {
  width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
});

await wsSend(ws, "Page.navigate", { url: BASE });
await waitFor(ws, `document.readyState === "complete"`, 60_000);
const navReady = await waitFor(ws, `document.querySelector('nav[aria-label="Primary"]')`, 45_000);
if (!navReady) {
  const diag = await evalJs(ws, `({ ready: document.readyState, bodyLen: document.body?.textContent?.length ?? 0, errs: window.__errs ?? [] })`);
  console.error("nav never mounted — diag:", JSON.stringify(diag));
  console.error("SUMMARY: 0 passed, 1 failed — app shell did not render");
  process.exit(1);
}

// Boot first, THEN seed against the live persist shape, THEN reload.
// Debounce dance: a boot-time store set() can flush its 5-demo blob AFTER our
// write (450ms debounced storage). Wait out the debounce window, re-seed, then
// reload — the last write wins and no stale timer remains to clobber it.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(700);
let seeded = await evalJs(ws, APPEND_SEED);
if (!seeded?.ok) { console.error("SUMMARY: 0 passed, 1 failed — seed failed:", JSON.stringify(seeded)); process.exit(1); }
await sleep(700);
seeded = await evalJs(ws, APPEND_SEED);
console.log(`  🌱 seeded — expected total workflows: ${seeded.total}`);
await wsSend(ws, "Page.reload", { ignoreCache: true });
// The old DOM can answer the nav probe before the reload swap — gate on the
// NEW document's readyState (resets to loading on reload) before probing.
await waitFor(ws, `document.readyState === "complete"`, 60_000);
await waitFor(ws, `document.querySelector('nav[aria-label="Primary"]')`, 45_000);
// error hook AFTER reload (SEED ran pre-reload era one; re-arm now for the rest)
await evalJs(ws, `
  window.__errs = [];
  window.addEventListener("error", (e) => window.__errs.push(String(e.message)));
  window.addEventListener("unhandledrejection", (e) => window.__errs.push(String(e.reason?.message ?? e.reason)));
`);

// open the Workflows view — poll the click: hydration can briefly unmount
let opened = false;
for (let i = 0; i < 25 && !opened; i++) {
  opened = await evalJs(ws, `(() => {
    const btns = [...document.querySelectorAll('nav[aria-label="Primary"] button')];
    const b = btns.find((x) => x.textContent.includes("Workflows"));
    if (!b) return false;
    b.click(); return true;
  })()`);
  if (!opened) await new Promise((r) => setTimeout(r, 400));
}
if (!opened) { console.error("SUMMARY: 0 passed, 1 failed — Workflows nav button not found"); process.exit(1); }
await waitFor(ws, `document.querySelector('input[aria-label="Search pipelines"]')`, 15_000);

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`  ${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
};
const TOTAL = seeded.total;

// T1 — box renders, all cards visible
const t1 = await evalJs(ws, `(() => {
  const box = document.querySelector('input[aria-label="Search pipelines"]');
  return { box: Boolean(box), cards: document.querySelectorAll("[data-wf-card]").length };
})()`);
check("T1 search box + all cards initially", t1.box && t1.cards === TOTAL, `cards=${t1.cards} expected=${TOTAL}`);

// T2 — name needle
await evalJs(ws, TYPE_INTO("zephyr digest"));
await waitFor(ws, `document.querySelectorAll("[data-wf-card]").length === 1`, 5_000);
const t2 = await evalJs(ws, `(() => ({
  cards: document.querySelectorAll("[data-wf-card]").length,
  name: document.querySelector("[data-wf-card] h3")?.textContent ?? "",
  count: [...document.querySelectorAll('span[aria-live="polite"]')].map((s) => s.textContent).join(""),
}))()`);
check("T2 name needle 'zephyr digest'", t2.cards === 1 && t2.name === "Zephyr Digest v237" && t2.count.includes(`1 of ${TOTAL}`), `cards=${t2.cards} name="${t2.name}" count="${t2.count}"`);

// T3 — instruction needle
await evalJs(ws, TYPE_INTO("quartz"));
await waitFor(ws, `document.querySelectorAll("[data-wf-card]").length === 1`, 5_000);
const t3 = await evalJs(ws, `(() => ({
  cards: document.querySelectorAll("[data-wf-card]").length,
  name: document.querySelector("[data-wf-card] h3")?.textContent ?? "",
}))()`);
check("T3 instruction needle 'quartz' → Code Reviewer v237", t3.cards === 1 && t3.name === "Code Reviewer v237", `cards=${t3.cards} name="${t3.name}"`);

// T4 — agent-name needle
await evalJs(ws, TYPE_INTO("moss walker"));
await waitFor(ws, `document.querySelectorAll("[data-wf-card]").length === 1`, 5_000);
const t4 = await evalJs(ws, `(() => ({
  cards: document.querySelectorAll("[data-wf-card]").length,
  name: document.querySelector("[data-wf-card] h3")?.textContent ?? "",
}))()`);
check("T4 agent-name needle 'moss walker' → Garden Planner v237", t4.cards === 1 && t4.name === "Garden Planner v237", `cards=${t4.cards} name="${t4.name}"`);

// T5 — schedule-task needle (r238: matches ONLY schedule.task, no other field)
await evalJs(ws, TYPE_INTO("kepler telemetry"));
await waitFor(ws, `document.querySelectorAll("[data-wf-card]").length === 1`, 5_000);
const t5 = await evalJs(ws, `(() => ({
  cards: document.querySelectorAll("[data-wf-card]").length,
  name: document.querySelector("[data-wf-card] h3")?.textContent ?? "",
  // r239: the schedule-task hit must be VISIBLE on the card itself
  text: document.querySelector("[data-wf-card]")?.textContent ?? "",
}))()`);
check("T5 schedule-task needle 'kepler telemetry' → Zephyr Digest v237 (task text visible)", t5.cards === 1 && t5.name === "Zephyr Digest v237" && t5.text.includes("kepler telemetry digest"), `cards=${t5.cards} name="${t5.name}" visible=${t5.text.includes("kepler telemetry digest")}`);

// T6 — no-match → empty state → Clear restores
await evalJs(ws, TYPE_INTO("zzzqqq"));
await waitFor(ws, `document.body.textContent.includes("No pipelines match")`, 5_000);
const t5a = await evalJs(ws, `(() => ({
  empty: document.body.textContent.includes("No pipelines match"),
  cards: document.querySelectorAll("[data-wf-card]").length,
}))()`);
await evalJs(ws, `document.querySelector('[aria-label="Clear pipeline search"]')?.click()`);
await waitFor(ws, `document.querySelectorAll("[data-wf-card]").length === ${TOTAL}`, 5_000);
const t5b = await evalJs(ws, `(() => ({
  cards: document.querySelectorAll("[data-wf-card]").length,
  value: document.querySelector('input[aria-label="Search pipelines"]')?.value ?? "?",
}))()`);
check("T6 no-match empty state", t5a.empty && t5a.cards === 0, `empty=${t5a.empty} cards=${t5a.cards}`);
check("T6b Clear button restores all + empties input", t5b.cards === TOTAL && t5b.value === "", `cards=${t5b.cards} value="${t5b.value}"`);

// T7 — "/" hotkey focuses the box (guarded away from inputs by the feature)
await evalJs(ws, `document.activeElement?.blur?.(); document.body.focus();`);
await evalJs(ws, `document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "/", bubbles: true, cancelable: true }))`);
const t7 = await evalJs(ws, `document.activeElement?.getAttribute("aria-label")`);
check("T7 '/' focuses the search box", t7 === "Search pipelines", `activeElement aria-label=${JSON.stringify(t7)}`);

await evalJs(ws, TYPE_INTO("zephyr digest"));
await waitFor(ws, `document.querySelectorAll("[data-wf-card]").length === 1`, 5_000);
await shot(ws, "s-series-search");

const errs = await evalJs(ws, `window.__errs ?? []`);
check("no console errors during suite", Array.isArray(errs) && errs.length === 0, JSON.stringify(errs ?? []).slice(0, 200));

const passed = results.filter((r) => r.ok).length;
console.log(`SUMMARY: ${passed} passed, ${results.length - passed} failed`);
process.exit(passed === results.length ? 0 : 1);
