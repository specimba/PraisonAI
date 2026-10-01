// ─── QA — R-series (r159): Radar view mount cost MEASUREMENT ────────────────
// The last main view never measured (r151 measured Workflows; r150 the ticker).
// Radar = 972-line view, 4 tabs (models/github/hf/papers) on Radix Tabs
// (inactive content unmounts), 3 external-proxy panels + the tracker strip.
// Design (mirrors P-series calibration: PASS = ΔScript<400ms, ≤2 longtasks):
//   R1  COLD mount: nav click → sentinel — CDP Performance deltas + longtasks.
//       First hit in dev compiles the lazy chunk → RECORDED, not judged.
//   R2  WARM remount: navigate to Chat and back → the honest steady-state.
//       PASS: ΔScript < 400ms, ≤2 longtasks.
//   R3  DOM growth during warm remount (record-only).
//   R4  perceived mount: click → sentinel visible (record-only).
//   R5  TAB-SWITCH economy (radar-specific): with a cache present, visiting
//       every tab once then returning must fire ZERO /api/radar|/api/tracker
//       fetches per re-activation (cache-first doctrine, didAuto per mount).
//       PASS: 0 refetches across 3 re-activations.
// Usage: node scripts/cdp-qa-radar-mount.mjs [baseUrl]
// Chrome (atomic, pkill after):
//   setsid ~/.cache/ms-playwright/chromium_headless_shell-1200/chrome-headless-shell-linux64/chrome-headless-shell \
//     --remote-debugging-port=9222 --window-size=1440,1000 about:blank &

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
  return (await wsSend(ws, "Performance.getMetrics")).metrics;
}

function diff(before, after, names) {
  const out = {};
  for (const n of names) {
    out[n] = (after.find((m) => m.name === n)?.value ?? 0) - (before.find((m) => m.name === n)?.value ?? 0);
  }
  return out;
}

// r150 lesson (bitten twice): sidebar nav buttons bundle label + hint text —
// match with startsWith, never exact.
async function navClick(ws, label) {
  return evalJs(ws, js(`
    const b = [...document.querySelectorAll("button")].find((x) => (x.textContent ?? "").trim().startsWith(${JSON.stringify(label)}));
    if (!b) throw new Error(${JSON.stringify(label)} + " nav not found");
    b.click();
    return true;
  `));
}

// Sentinel: the radar tablist is the view's stable skeleton (aria-label from
// radar-view.tsx), and body text "GitHub stars" appears in the nav hint too —
// so detect the TABLIST element, not text.
const SENTINEL = `!!document.querySelector('[role="tablist"][aria-label="Trend radar sections"]')`;

async function awaitSentinel(ws, budgetMs) {
  return evalJs(ws, js(`
    return new Promise((resolve) => {
      const t0 = performance.now();
      const iv = setInterval(() => {
        if (${SENTINEL}) { clearInterval(iv); return resolve(Math.round(performance.now() - t0)); }
        if (performance.now() - t0 > ${budgetMs}) { clearInterval(iv); return resolve(-1); }
      }, 60);
    });
  `));
}

async function main() {
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

  await wsSend(ws, "Performance.enable");

  await evalJs(ws, js(`
    window.__pTasks = [];
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) window.__pTasks.push(Math.round(e.duration));
    }).observe({ entryTypes: ["longtask"] });
    return true;
  `));

  // r160: the ACTIVE VIEW is persisted (zustand persist) — a fresh tab can
  // restore the radar view, which would make R1's "cold" mount measure
  // nothing (sentinel already true, zero deltas). Force Chat first.
  const alreadyRadar = await evalJs(ws, js(`return ${SENTINEL};`));
  if (alreadyRadar) {
    await navClick(ws, "Chat");
    await sleep(1500);
  }

  // ── R1: COLD mount ──
  const coldBefore = await metricsDelta(ws);
  await evalJs(ws, js(`window.__pTasks.length = 0; return true;`));
  await navClick(ws, "Radar");
  const coldVisible = await awaitSentinel(ws, 15000);
  await sleep(2500);
  const coldAfter = await metricsDelta(ws);
  const cold = diff(coldBefore, coldAfter, ["ScriptDuration", "LayoutCount", "RecalcStyleCount", "Nodes"]);
  const coldTasks = JSON.parse(await evalJs(ws, js(`return JSON.stringify(window.__pTasks);`)));
  console.log(`  [R1 cold] sentinel=${coldVisible}ms ΔScript=${cold.ScriptDuration.toFixed(3)}s ΔLayout=${cold.LayoutCount} ΔStyle=${cold.RecalcStyleCount} ΔNodes=${cold.Nodes} longtasks=${JSON.stringify(coldTasks)}`);

  // ── R2/R3/R4: WARM remount (chat → radar again) ──
  await navClick(ws, "Chat");
  await sleep(1500);
  const warmBefore = await metricsDelta(ws);
  await evalJs(ws, js(`window.__pTasks.length = 0; return true;`));
  await navClick(ws, "Radar");
  const warmVisible = await awaitSentinel(ws, 15000);
  await sleep(2500);
  const warmAfter = await metricsDelta(ws);
  const warm = diff(warmBefore, warmAfter, ["ScriptDuration", "LayoutCount", "RecalcStyleCount", "Nodes"]);
  const warmTasks = JSON.parse(await evalJs(ws, js(`return JSON.stringify(window.__pTasks);`)));
  console.log(`  [R2 warm] sentinel=${warmVisible}ms ΔScript=${warm.ScriptDuration.toFixed(3)}s ΔLayout=${warm.LayoutCount} ΔStyle=${warm.RecalcStyleCount} ΔNodes=${warm.Nodes} longtasks=${JSON.stringify(warmTasks)}`);

  check(
    "R2 warm remount cheap (ΔScript<400ms, ≤2 longtasks)",
    warm.ScriptDuration < 0.4 && warmTasks.length <= 2,
    `ΔScript=${warm.ScriptDuration.toFixed(3)}s, ${warmTasks.length} longtask(s)${warmTasks.length ? `: ${JSON.stringify(warmTasks)}` : ""}, sentinel=${warmVisible}ms`
  );
  console.log(`  [R3 record] warm ΔNodes=${warm.Nodes} (DOM growth)`);
  console.log(`  [R4 record] cold sentinel=${coldVisible}ms / warm=${warmVisible}ms`);

  // ── R5: tab-switch economy — visit all 4 tabs, then re-visit 3 of them ──
  const tabIds = ["github", "hf", "papers"];
  const marker = () => evalJs(ws, js(`
    // r160: scope to the TAB proxies only — the tracker ticker strip is
    // always-mounted above the Tabs and polls /api/tracker on its own 15min
    // cadence; a poll landing inside the marker window is legitimate app
    // behavior, not a tab-economy violation.
    const m = performance.getEntriesByType("resource").filter((e) => /\\/api\\/radar\\//.test(e.name)).length;
    return m;
  `));
  // Visit each secondary tab once (first mount may legitimately fetch).
  // Radix TabsTrigger exposes no reliable value attribute — match by label.
  // r160 CORRECTION: Radix activates tabs on POINTERDOWN — a synthetic
  // .click() silently switches nothing, which made r159's R5 run measure
  // nothing (0 switches → 0 fetches → false PASS). Dispatch the full pointer
  // sequence so the switch actually happens.
  const clickTab = (label) => evalJs(ws, js(`
    const t = [...document.querySelectorAll('[role="tab"]')].find((x) => (x.textContent ?? "").includes(${JSON.stringify(label)}));
    if (!t) throw new Error("tab not found: " + ${JSON.stringify(label)});
    t.focus();
    t.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    t.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    t.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    return true;
  `));
  for (const v of ["GitHub Stars", "HF Trending", "Paper Radar"]) {
    await clickTab(v);
    await sleep(1200);
  }
  const before = await marker();
  for (const v of ["GitHub Stars", "HF Trending", "Paper Radar"]) {
    await clickTab(v);
    await sleep(900);
  }
  const after = await marker();
  // r160: the switch-actually-happened guard — a false PASS here means the
  // pointer sequence broke again and the gate is measuring nothing.
  const switched = await evalJs(ws, js(`
    const t = [...document.querySelectorAll('[role="tab"]')].find((x) => (x.textContent ?? "").includes("Paper Radar"));
    return t?.getAttribute("aria-selected") === "true";
  `));
  const refetches = after - before;
  check(
    "R5 tab re-activation cache-first (0 proxy refetches)",
    refetches === 0 && switched === true,
    `${refetches} refetch(es) across 3 re-activations, switches-verified=${switched}`
  );

  await shot(ws, "R-radar-mount");

  ws.close();
  const pass = results.filter((r) => r.ok).length;
  console.log(`\n${pass}/${results.length} checks passed`);
  process.exit(pass === results.length ? 0 : 1);
}

main().catch((err) => {
  console.error("QA run failed:", err.stack ?? err.message);
  process.exit(2);
});
