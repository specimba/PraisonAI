import { ensureChrome } from "./cdp-ensure-chrome.mjs";
// ─── CDP QA — W-series (r156): reproduce the user's 0/11 scheduled-pipeline runs ──
// User report: "Continuous Research…" hourly pipeline — 12 runs, ~all end 0/11
// steps done in 204-449s with 2-3 tool calls (one 7104s for 1/11). Root-cause hunt.
// Method: seed a FRESH browser (localStorage before app scripts) with 5 agents
// (model "auto") + the user's 9-step pipeline (depth=deep → 11 run steps —
// matches "0/11"), trigger a manual Run, and poll the persisted store until the
// run finalizes. Whatever kills their runs should kill this one — and this time
// we capture the RunErrorInfo verbatim.
// Usage: node scripts/cdp-qa-pipeline-zero-steps.mjs [baseUrl] [maxWaitMin]
import fs from "node:fs";
import path from "node:path";

const BASE = process.argv[2] ?? "http://localhost:3000";
const MAX_MS = (Number(process.argv[3] ?? 9) || 9) * 60_000;
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

// ─── seed material ────────────────────────────────────────────────────────────
const NOW = Date.now();
const mkAgent = (id, name, emoji, role, instructions, tools) => ({
  id, name, emoji, color: "violet", role, description: role, instructions,
  model: "auto", temperature: 0.4, maxIterations: 4, tools,
  createdAt: NOW, updatedAt: NOW,
});
const AGENTS = [
  mkAgent("w-research", "Research Scout", "🔍", "Research Scout", "You research topics with web tools. Cite sources.", ["web_search", "arxiv_search", "read_url"]),
  mkAgent("w-coder", "Code Smith", "👨‍💻", "Code Smith", "You analyze code and systems.", []),
  mkAgent("w-planner", "Strategic Planner", "🗺️", "Strategic Planner", "You plan and structure work.", []),
  mkAgent("w-writer", "Tech Writer", "✍️", "Tech Writer", "You write tight, cited briefings.", []),
  mkAgent("w-assistant", "Praison Assistant", "🤖", "Praison Assistant", "You review and refine.", []),
];
const ROT = ["w-research", "w-coder", "w-planner", "w-writer", "w-assistant"];
const LABELS = [
  "Establish three research tracks", "Inventory system context", "Build a source plan",
  "Search implementation evidence", "Layered time-horizon pass", "Search the topic map",
  "Run complementary discovery", "Maintain the evidence register", "Review & refine",
];
const WF = {
  id: "w-repro-zero", name: "Repro: Continuous Research (0/11)", description: "r156 repro of the user's hourly pipeline",
  steps: LABELS.map((label, i) => ({ id: `ws-${i}`, agentId: ROT[i], label, kind: i === 8 ? "review" : "generate" })),
  runs: [], createdAt: NOW, updatedAt: NOW, depth: "deep",
  schedule: { enabled: false, intervalMs: 3600_000, task: "routine every 1 hour for improved reports and ready-to-implementation ideas" },
};
const SEED = `
  localStorage.setItem("praison-agents", JSON.stringify({ state: { agents: ${JSON.stringify(AGENTS)} }, version: 1 }));
  localStorage.setItem("praison-workflows", JSON.stringify({ state: { workflows: [${JSON.stringify(WF)}], selectedId: null }, version: 0 }));
  window.__errs = [];
  window.addEventListener("error", (e) => window.__errs.push(String(e.message)));
  window.addEventListener("unhandledrejection", (e) => window.__errs.push(String(e.reason?.message ?? e.reason)));
`;

const READ_RUN = `
  (() => {
    const raw = localStorage.getItem("praison-workflows");
    if (!raw) return null;
    const wf = (JSON.parse(raw)?.state?.workflows ?? []).find(w => w.id === "w-repro-zero");
    const run = wf?.runs?.[wf.runs.length - 1];
    if (!run) return { hasRun: false };
    return {
      hasRun: true, status: run.status, startedAt: run.startedAt, finishedAt: run.finishedAt,
      stepsDone: run.steps.filter(s => s.status === "done").length,
      stepStates: run.steps.map(s => s.status),
      stepMs: run.steps.map(s => s.ms ?? null),
      toolCalls: run.steps.map(s => (s.toolCalls ?? []).length),
      error: run.error ?? null,
      callLog: (run.callLog ?? []).slice(-8).map(c => ({ model: c.model, lane: c.lane ?? c.transport, ok: c.ok, ms: c.ms, err: (c.err ?? c.error ?? "").toString().slice(0, 160) })),
    };
  })()`;

async function main() {
  await ensureChrome();
  const tab = await (await fetch("http://127.0.0.1:9222/json/new", { method: "PUT" })).json();
  const ws = await connect(tab.webSocketDebuggerUrl);
  await wsSend(ws, "Page.enable");
  await wsSend(ws, "Runtime.enable");
  // Seed BEFORE any app script runs (Q-series lesson)
  await wsSend(ws, "Page.addScriptToEvaluateOnNewDocument", { source: SEED });
  await wsSend(ws, "Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await wsSend(ws, "Page.navigate", { url: BASE });
  await evalJs(ws, "document.title");
  await waitFor(ws, `document.readyState === 'complete'`);
  await new Promise((r) => setTimeout(r, 2500));
  const seeded = await evalJs(ws, `JSON.parse(localStorage.getItem("praison-agents") ?? "{}")?.state?.agents?.length ?? 0`);
  console.log("seeded agents:", seeded);

  // Nav to Workflows (sidebar buttons bundle label+hint → startsWith)
  for (let i = 0; i < 6; i++) {
    const ok = await evalJs(ws, `(() => { const el = [...document.querySelectorAll("button,a")].find(e => (e.textContent || "").trim().startsWith("Workflows") && e.offsetParent !== null); if (!el) return false; el.click(); return true; })()`);
    if (ok) break;
    await new Promise((r) => setTimeout(r, 800));
  }
  await waitFor(ws, `document.body.innerText.includes("Repro: Continuous Research")`, 15_000);

  // Start a run: card dropdown ("Actions for …") → Run menu item → panel Run
  let started = false;
  for (let i = 0; i < 6 && !started; i++) {
    await evalJs(ws, `(() => { const t = document.querySelector('button[aria-label="Actions for Repro: Continuous Research (0/11)"]'); if (!t) return false; t.click(); return true; })()`);
    await new Promise((r) => setTimeout(r, 900));
    // Radix renders menu items in a portal — pick the "Run" menuitem
    await evalJs(ws, `(() => { const mi = [...document.querySelectorAll('[role="menuitem"]')].find(e => (e.textContent || "").trim() === "Run"); if (!mi) return false; mi.click(); return true; })()`);
    await new Promise((r) => setTimeout(r, 1200));
    // Run panel: fill the task input if present, then click its Run button
    await evalJs(ws, `(() => { const inp = [...document.querySelectorAll("textarea,input")].find(e => (e.placeholder || "").includes("Describe the task")); if (inp) { const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype ?? HTMLInputElement.prototype, "value")?.set ?? Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; set.call(inp, "routine every 1 hour for improved reports and ready-to-implementation ideas"); inp.dispatchEvent(new Event("input", { bubbles: true })); } return true; })()`);
    await evalJs(ws, `(() => { const btn = [...document.querySelectorAll("button")].filter(b => (b.textContent || "").trim() === "Run" && b.offsetParent !== null && !b.closest('[role="menu"]')).at(-1); if (!btn) return false; btn.click(); return true; })()`);
    await new Promise((r) => setTimeout(r, 1500));
    started = await evalJs(ws, `(function(){ const raw = localStorage.getItem("praison-workflows"); const wf = raw && (JSON.parse(raw).state.workflows ?? []).find(w => w.id === "w-repro-zero"); return Boolean(wf && wf.runs.length > 0); })()`);
  }
  console.log("run started:", started);
  if (!started) { console.log("FATAL: could not start a run"); process.exit(1); }

  // Poll until finalize
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < MAX_MS) {
    await new Promise((r) => setTimeout(r, 20_000));
    last = await evalJs(ws, READ_RUN);
    console.log(`[${Math.round((Date.now() - t0) / 1000)}s] status=${last.status} done=${last.stepsDone}/${last.stepStates.length} states=${last.stepStates.join(",")} errs=${JSON.stringify(last.stepMs)}`);
    if (last.status && last.status !== "running") break;
  }
  console.log("\n=== FINAL RUN STATE ===");
  console.log(JSON.stringify(last, null, 2));
  const errs = await evalJs(ws, `window.__errs ?? []`);
  console.log("window errors:", JSON.stringify(errs.slice(0, 10)));
  await shot(ws, "W-repro-final");
  process.exit(0);
}

main().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
