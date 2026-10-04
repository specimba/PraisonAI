import { ensureChrome } from "./cdp-ensure-chrome.mjs";
// ─── QA — P-series (r151): Workflows view mount cost MEASUREMENT ────────────
// The heaviest view (1669-line workflows-view + kanban + autopilot panel +
// evolution ledger) was never measured. Design:
//   P1  COLD mount: nav click → 3s window — CDP Performance deltas (Script/
//       Layout/Style/Nodes) + longtasks. First hit in dev compiles the lazy
//       chunk, so this is RECORDED, not judged.
//   P2  WARM remount: navigate to Chat and back → 3s window — the honest
//       steady-state number. PASS: ΔScript < 400ms, ≤2 longtasks.
//   P3  DOM growth during warm remount (record-only).
//   P4  perceived mount: click → Server autopilot text visible (record-only).
// Usage: node scripts/cdp-qa-workflows-mount.mjs [baseUrl]

import fs from "node:fs";
import path from "node:path";

const BASE = process.argv[2] ?? "http://localhost:3000";
const OUT_DIR = path.resolve("ops/qa");
fs.mkdirSync(OUT_DIR, { recursive: true });

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
}

let msgId = 0;
const pending = new Map();

function wsSend(ws, method, params = {}) {
  if (typeof ws?.send !== "function") {
    throw new Error(`ws.send missing: typeof=${typeof ws} ctor=${ws?.constructor?.name}`);
  }
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }
    }, 30_000);
  });
}

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error("ws error"));
  });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    }
  };
  return ws;
}

async function evalJs(ws, expression) {
  const r = await wsSend(ws, "Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description ?? "eval error");
  }
  return r.result?.value;
}

async function shot(ws, name) {
  const r = await wsSend(ws, "Page.captureScreenshot", { format: "png" });
  const file = path.join(OUT_DIR, `${name}.png`);
  fs.writeFileSync(file, Buffer.from(r.data, "base64"));
  console.log(`  📸 ${file}`);
}

const js = (s) => `(function(){ ${s} })()`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function metricsDelta(ws) {
  const a = (await wsSend(ws, "Performance.getMetrics")).metrics;
  return a;
}

function diff(before, after, names) {
  const out = {};
  for (const n of names) {
    out[n] = (after.find((m) => m.name === n)?.value ?? 0) - (before.find((m) => m.name === n)?.value ?? 0);
  }
  return out;
}

async function main() {
  await ensureChrome();
  const tabRes = await fetch(`http://127.0.0.1:9222/json/new`, { method: "PUT" });
  if (!tabRes.ok) throw new Error(`/json/new failed: ${tabRes.status}`);
  const tab = await tabRes.json();
  const ws = await connect(tab.webSocketDebuggerUrl);
  await wsSend(ws, "Page.enable");
  await wsSend(ws, "Runtime.enable");
  await wsSend(ws, "Emulation.setDeviceMetricsOverride", {
    width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false,
  });
  await wsSend(ws, "Page.navigate", { url: BASE });
  await evalJs(ws, "document.title");
  await sleep(1500);

  await evalJs(ws, js(`
    Object.defineProperty(document, "hidden", { get: () => false, configurable: true });
    Object.defineProperty(document, "visibilityState", { get: () => "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    return document.visibilityState;
  `));

  // r151 lesson: without Performance.enable the getMetrics domain returns
  // frozen all-zero values — deltas silently compute as 0-0. Enable FIRST.
  await wsSend(ws, "Performance.enable");

  await evalJs(ws, js(`
    window.__pTasks = [];
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) window.__pTasks.push(Math.round(e.duration));
    }).observe({ entryTypes: ["longtask"] });
    return true;
  `));

  const navClick = () => evalJs(ws, js(`
    const b = [...document.querySelectorAll("button")].find((x) => (x.textContent ?? "").trim().startsWith("Workflows"));
    if (!b) throw new Error("Workflows nav not found");
    b.click();
    return true;
  `));

  // ── P1: COLD mount (dev chunk compile included — recorded, not judged) ──
  const coldBefore = await metricsDelta(ws);
  await evalJs(ws, js(`window.__pTasks.length = 0; return true;`));
  const t0 = Date.now();
  await navClick();
  const coldVisible = await evalJs(ws, js(`
    return new Promise((resolve) => {
      const t0 = performance.now();
      const iv = setInterval(() => {
        if (document.body.textContent.includes("Workflow Studio")) {
          clearInterval(iv);
          return resolve(Math.round(performance.now() - t0));
        }
        if (performance.now() - t0 > 15000) { clearInterval(iv); return resolve(-1); }
      }, 100);
    });
  `));
  await sleep(2500);
  const coldAfter = await metricsDelta(ws);
  const cold = diff(coldBefore, coldAfter, ["ScriptDuration", "LayoutCount", "RecalcStyleCount", "Nodes"]);
  const coldTasks = JSON.parse(await evalJs(ws, js(`return JSON.stringify(window.__pTasks);`)));
  console.log(`  [P1 cold] text-visible=${coldVisible}ms ΔScript=${cold.ScriptDuration.toFixed(3)}s ΔLayout=${cold.LayoutCount} ΔStyle=${cold.RecalcStyleCount} ΔNodes=${cold.Nodes} longtasks=${JSON.stringify(coldTasks)}`);

  // ── P2/P3/P4: WARM remount (chat → workflows again) ──
  await evalJs(ws, js(`
    const b = [...document.querySelectorAll("button")].find((x) => (x.textContent ?? "").trim() === "Chat");
    if (b) { b.click(); return "chat-clicked"; }
    return "chat-stay";
  `));
  await sleep(1500);
  const warmBefore = await metricsDelta(ws);
  await evalJs(ws, js(`window.__pTasks.length = 0; return true;`));
  const t1 = Date.now();
  await navClick();
  const warmVisible = await evalJs(ws, js(`
    return new Promise((resolve) => {
      const t0 = performance.now();
      const iv = setInterval(() => {
        if (document.body.textContent.includes("Workflow Studio")) {
          clearInterval(iv);
          return resolve(Math.round(performance.now() - t0));
        }
        if (performance.now() - t0 > 15000) { clearInterval(iv); return resolve(-1); }
      }, 50);
    });
  `));
  await sleep(2500);
  const warmAfter = await metricsDelta(ws);
  const warm = diff(warmBefore, warmAfter, ["ScriptDuration", "LayoutCount", "RecalcStyleCount", "Nodes"]);
  const warmTasks = JSON.parse(await evalJs(ws, js(`return JSON.stringify(window.__pTasks);`)));
  console.log(`  [P2 warm] text-visible=${warmVisible}ms ΔScript=${warm.ScriptDuration.toFixed(3)}s ΔLayout=${warm.LayoutCount} ΔStyle=${warm.RecalcStyleCount} ΔNodes=${warm.Nodes} longtasks=${JSON.stringify(warmTasks)}`);

  check(
    "P2 warm remount cheap (ΔScript<400ms, ≤2 longtasks)",
    warm.ScriptDuration < 0.4 && warmTasks.length <= 2,
    `ΔScript=${warm.ScriptDuration.toFixed(3)}s, ${warmTasks.length} longtask(s)${warmTasks.length ? `: ${JSON.stringify(warmTasks)}` : ""}, text-visible=${warmVisible}ms`
  );
  console.log(`  [P3 record] warm ΔNodes=${warm.Nodes} (DOM growth)`);
  console.log(`  [P4 record] cold text-visible=${coldVisible}ms / warm=${warmVisible}ms`);

  await shot(ws, "P-workflows-mount");

  ws.close();
  const pass = results.filter((r) => r.ok).length;
  console.log(`\n${pass}/${results.length} checks passed`);
  process.exit(pass === results.length ? 0 : 1);
}

main().catch((err) => {
  console.error("QA run failed:", err.stack ?? err.message);
  process.exit(2);
});
