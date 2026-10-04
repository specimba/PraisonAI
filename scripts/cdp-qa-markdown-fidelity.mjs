import { ensureChrome } from "./cdp-ensure-chrome.mjs";
// ─── CDP QA — T-series (r241): shared MarkdownRenderer fidelity ──────────────
// Feature under test: markdown.tsx img override (lazy load + width clamp +
// broken-image fallback) and GFM task-list checkbox styling.
//  T1  data-URI image loads, has loading="lazy" + max-w-full clamp
//  T2  hallucinated URL → <img> replaced by [data-md-img-fallback] keeping alt
//  T3  GFM task list: 2 disabled checkboxes, first checked, li bullet removed
//  T4  no console errors during the suite
// Seeding doctrine (debouncedStorage 450ms): boot → sleep 700 → seed →
// sleep 700 → re-seed → reload. Fresh profiles never wrote the persist key,
// so create the blob with the app's default version (conversations: none → 0).
// Usage: node scripts/cdp-qa-markdown-fidelity.mjs [baseUrl]
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

// ─── seed material: collision-immune tokens (v241 / markdown-fidelity) ──────
const NOW = Date.now();
// 1x1 PNG that actually loads (deterministic, no network)
const PIXEL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const MD = [
  "## Delivery checklist v241",
  "",
  "- [x] load the diagram",
  "- [ ] verify the fallback",
  "",
  // NOTE: a blank line alone does NOT split two same-marker lists in
  // CommonMark (they merge into one loose list) — a paragraph between them
  // guarantees a second, separate <ul> for the plain-bullet assertion.
  "Context paragraph v241.",
  "",
  "- plain bullet one v241",
  "- plain bullet two v241",
  "",
  "![arch diagram v241](https://example.invalid/arch-v241.png)",
  "",
  `![pixel v241](${PIXEL})`,
].join("\n");
const CONV = {
  id: "conv-t241-markdown",
  title: "Markdown fidelity v241",
  agentId: null,
  workflowId: null,
  messages: [
    { id: "msg-t241-u", role: "user", content: "Show the delivery checklist", agentId: null, createdAt: NOW, toolCalls: [], status: "done" },
    { id: "msg-t241-a", role: "assistant", content: MD, agentId: null, agentName: "Doc Bot v241", createdAt: NOW + 1, toolCalls: [], status: "done", model: "auto" },
  ],
  createdAt: NOW,
  updatedAt: NOW,
};
const SEED = `
  (() => {
    const key = Object.keys(localStorage).find((k) => /conversation/i.test(k));
    const mine = ${JSON.stringify(CONV)};
    if (!key) {
      localStorage.setItem("praison-conversations", JSON.stringify({ state: { conversations: [mine], activeId: mine.id }, version: 0 }));
      return { ok: true, total: 1 };
    }
    const blob = JSON.parse(localStorage.getItem(key) || "{}");
    const list = Array.isArray(blob?.state?.conversations) ? blob.state.conversations : [];
    const cleaned = list.filter((c) => c.id !== mine.id);
    localStorage.setItem(key, JSON.stringify({ state: { conversations: [mine, ...cleaned], activeId: mine.id }, version: blob.version ?? 0 }));
    return { ok: true, total: cleaned.length + 1 };
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
  const diag = await evalJs(ws, `({ ready: document.readyState, bodyLen: document.body?.textContent?.length ?? 0 })`);
  console.error("nav never mounted — diag:", JSON.stringify(diag));
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
console.log(`  🌱 seeded — conversations total: ${seeded.total}`);
await wsSend(ws, "Page.reload", { ignoreCache: true });
// Gate on the NEW document's readyState before probing (reload DOM race).
await waitFor(ws, `document.readyState === "complete"`, 60_000);
await waitFor(ws, `document.querySelector('nav[aria-label="Primary"]')`, 45_000);
await evalJs(ws, `
  window.__errs = [];
  window.addEventListener("error", (e) => window.__errs.push(String(e.message)));
  window.addEventListener("unhandledrejection", (e) => window.__errs.push(String(e.reason?.message ?? e.reason)));
`);

// open the Chat view — poll the click: hydration can briefly unmount
let opened = false;
for (let i = 0; i < 25 && !opened; i++) {
  opened = await evalJs(ws, `(() => {
    const btns = [...document.querySelectorAll('nav[aria-label="Primary"] button')];
    const b = btns.find((x) => x.textContent.includes("Chat"));
    if (!b) return false;
    b.click(); return true;
  })()`);
  if (!opened) await new Promise((r) => setTimeout(r, 400));
}
if (!opened) { console.error("SUMMARY: 0 passed, 1 failed — Chat nav button not found"); process.exit(1); }
await waitFor(ws, `document.querySelector('.md-body img')`, 15_000);

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`  ${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
};
// give the data-URI image a beat to decode
await waitFor(ws, `[...document.querySelectorAll('.md-body img')].some((i) => i.complete && i.naturalWidth > 0)`, 5_000);

// T1 — loaded data-URI image: lazy + width-clamped
const t1 = await evalJs(ws, `(() => {
  const img = [...document.querySelectorAll('.md-body img')].find((i) => i.src.startsWith("data:image/png"));
  if (!img) return { found: false };
  return { found: true, lazy: img.getAttribute("loading") === "lazy", clamped: img.className.includes("max-w-full"), loaded: img.complete && img.naturalWidth > 0 };
})()`);
check("T1 data-URI img renders lazy + max-w-full", t1.found && t1.lazy && t1.clamped && t1.loaded, JSON.stringify(t1));

// T2 — hallucinated URL: img replaced by visible fallback with alt kept
await waitFor(ws, `Boolean(document.querySelector('[data-md-img-fallback]'))`, 5_000);
const t2 = await evalJs(ws, `(() => {
  const fb = document.querySelector('[data-md-img-fallback]');
  const stillRaw = [...document.querySelectorAll('.md-body img')].some((i) => i.src.includes("example.invalid"));
  return {
    fb: Boolean(fb),
    alt: fb?.getAttribute("aria-label") ?? "",
    text: fb?.textContent ?? "",
    styled: Boolean(fb?.className?.includes("border-dashed")),
    rawImgGone: !stillRaw,
  };
})()`);
check("T2 broken URL → fallback keeps alt, raw <img> gone", t2.fb && t2.alt.includes("arch diagram v241") && t2.text.includes("arch diagram v241") && t2.styled && t2.rawImgGone, JSON.stringify(t2));

// T3 — GFM task list: checkboxes styled, checked state preserved, bullet gone;
// task UL keeps spacing (merged classes), a plain UL keeps its disc.
const t3 = await evalJs(ws, `(() => {
  const boxes = [...document.querySelectorAll('.md-body input[type="checkbox"]')];
  if (boxes.length !== 2) return { count: boxes.length };
  const li = boxes[0].closest("li");
  const taskUl = boxes[0].closest("ul");
  const plainUl = [...document.querySelectorAll('.md-body ul')].find((u) => !u.querySelector('input[type="checkbox"]'));
  return {
    count: boxes.length,
    firstChecked: boxes[0].checked === true,
    secondChecked: boxes[1].checked === true,
    disabled: boxes.every((b) => b.disabled),
    liBulletNone: li ? getComputedStyle(li).listStyleType === "none" : false,
    taskUlNoBullet: taskUl ? getComputedStyle(taskUl).listStyleType === "none" : false,
    taskUlPadded: Boolean(taskUl?.className?.includes("pl-2") && taskUl?.className?.includes("space-y-1")),
    plainUlDisc: plainUl ? getComputedStyle(plainUl).listStyleType === "disc" : false,
    violet: boxes[0].className.includes("accent-violet"),
  };
})()`);
check("T3 task-list checkboxes + merged ul classes", t3.count === 2 && t3.firstChecked && !t3.secondChecked && t3.disabled && t3.liBulletNone && t3.taskUlNoBullet && t3.taskUlPadded && t3.plainUlDisc && t3.violet, JSON.stringify(t3));

await shot(ws, "t-series-markdown");

const errs = await evalJs(ws, `window.__errs ?? []`);
check("no console errors during suite", Array.isArray(errs) && errs.length === 0, JSON.stringify(errs ?? []).slice(0, 200));

const passed = results.filter((r) => r.ok).length;
console.log(`SUMMARY: ${passed} passed, ${results.length - passed} failed`);
process.exit(passed === results.length ? 0 : 1);
