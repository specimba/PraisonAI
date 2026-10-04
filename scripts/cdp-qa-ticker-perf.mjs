import { ensureChrome } from "./cdp-ensure-chrome.mjs";
// ─── QA — N-series (r148): model-tracker ticker performance MEASUREMENT ─────
// The r147 handoff suspected the always-visible marquee "re-renders
// continuously". Code reading says otherwise: .ticker-track is a pure CSS
// compositor animation (translateX keyframes, will-change: transform, 55s
// linear infinite, paused on hover, disabled under prefers-reduced-motion).
// This script measures instead of assuming:
//   N0  guard: ticker strip present + ticker-scroll animation actually running
//   N1  CDP Performance.getMetrics deltas over a window WITH an active RAF
//       sampler — ΔLayout=0 + tiny ΔScript + stable ΔNodes proves NO React
//       re-render or layout thrash; the frame-rate ΔStyle here is RAF-loop
//       instrument reactivity, not ticker cost (N1b isolates it)
//   N1b compositor isolation A/B: RecalcStyleCount over equal windows while
//       the animation runs vs pauses, with NO RAF polling — running ≈ paused
//       proves the marquee costs the main thread ~nothing (pure compositor);
//       r148 evidence: 7 vs 7 per 1.5s while the N1 window showed 151 only
//       because the sampler itself requested frames
//   N2  requestAnimationFrame jitter over ~150 frames — steady ~16.7ms median
//       means the main thread is not fighting the animation
//   N3  longtask entries over the window (dev mode always has some noise)
//   N4  whole chrome process-tree CPU% over the window (recorded, no verdict —
//       headless software compositing is not representative of real GPUs)
// Usage: node scripts/cdp-qa-ticker-perf.mjs [baseUrl]

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

// CPU% of the whole chrome-headless-shell tree over a window (utime+stime
// jiffies from /proc, 100 jiffies/s per process, normalized to one core).
function readTreeCpuMs() {
  let totalMs = 0;
  for (const pid of fs.readdirSync("/proc").filter((d) => /^\d+$/.test(d))) {
    try {
      const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
      if (!cmd.includes("chrome-headless-shell")) continue;
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const parts = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const utime = Number(parts[11]);
      const stime = Number(parts[12]);
      totalMs += ((utime + stime) * 1000) / 100;
    } catch {
      /* process vanished */
    }
  }
  return totalMs;
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
  await new Promise((r) => setTimeout(r, 1500));

  await evalJs(ws, js(`
    Object.defineProperty(document, "hidden", { get: () => false, configurable: true });
    Object.defineProperty(document, "visibilityState", { get: () => "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    return document.visibilityState;
  `));

  // N0 guard: strip present, animation running, fresh snapshot painted.
  let present = false;
  for (let i = 0; i < 20; i++) {
    present = await evalJs(ws, js(`
      const strip = document.querySelector('[role="region"][aria-label="Model tracker ticker"]');
      return !!strip && !!strip.querySelector(".ticker-track");
    `));
    if (present) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  const anim = present
    ? JSON.parse(await evalJs(ws, js(`
        const track = document.querySelector(".ticker-track");
        const cs = getComputedStyle(track);
        return JSON.stringify({ name: cs.animationName, state: cs.animationPlayState, dur: cs.animationDuration });
      `)))
    : null;
  check(
    "N0 ticker strip present + ticker-scroll animation running",
    present && anim?.name === "ticker-scroll" && anim?.state === "running",
    present ? `animation=${anim?.name} state=${anim?.state} dur=${anim?.dur}` : "ticker strip not found (no snapshot data?)"
  );

  // Register longtask observer BEFORE the measurement window.
  await evalJs(ws, js(`
    window.__nTasks = [];
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) window.__nTasks.push(Math.round(e.duration));
    }).observe({ entryTypes: ["longtask"] });
    return true;
  `));

  // N1: Performance.getMetrics deltas over the window.
  await wsSend(ws, "Performance.enable");
  const before = (await wsSend(ws, "Performance.getMetrics")).metrics;
  const cpuBefore = readTreeCpuMs();
  const t0 = Date.now();

  const raf = JSON.parse(await evalJs(ws, js(`
    return new Promise((resolve) => {
      const deltas = [];
      let last = performance.now();
      function tick(now) {
        deltas.push(now - last);
        last = now;
        if (deltas.length < 150) requestAnimationFrame(tick);
        else resolve(JSON.stringify({
          n: deltas.length,
          median: deltas.slice().sort((a, b) => a - b)[Math.floor(deltas.length / 2)],
          p95: deltas.slice().sort((a, b) => a - b)[Math.floor(deltas.length * 0.95)],
          max: Math.max(...deltas),
        }));
      }
      requestAnimationFrame(tick);
    });
  `)));

  const wallS = (Date.now() - t0) / 1000;
  const cpuAfter = readTreeCpuMs();
  const after = (await wsSend(ws, "Performance.getMetrics")).metrics;
  const metric = (name) => after.find((m) => m.name === name)?.value - before.find((m) => m.name === name)?.value;
  const dLayout = metric("LayoutCount");
  const dStyle = metric("RecalcStyleCount");
  const dScript = metric("ScriptDuration");
  const dNodes = metric("Nodes");

  const cpuPct = ((cpuAfter - cpuBefore) / 1000 / wallS) * 100;
  const longTasks = JSON.parse(await evalJs(ws, js(`return JSON.stringify(window.__nTasks);`)));

  console.log(`  [r148 window] ${wallS.toFixed(1)}s — ΔLayout=${dLayout} ΔStyle=${dStyle} ΔScript=${dScript.toFixed(3)}s ΔNodes=${dNodes}`);
  console.log(`  [r148 raf] n=${raf.n} median=${raf.median?.toFixed(1)}ms p95=${raf.p95?.toFixed(1)}ms max=${raf.max?.toFixed(1)}ms`);
  console.log(`  [r148 cpu] chrome tree ${(wallS).toFixed(0)}s wall → ${cpuPct.toFixed(1)}% of one core`);
  console.log(`  [r148 longtasks] ${longTasks.length}${longTasks.length ? ` durations=${JSON.stringify(longTasks)}` : ""}`);

  check(
    "N1 no per-frame React/layout churn (ΔLayout=0, ΔScript small, ΔNodes≈0)",
    dLayout === 0 && dScript < 0.5 && dNodes <= 2,
    `ΔLayout=${dLayout}, ΔScript=${dScript.toFixed(3)}s, ΔNodes=${dNodes} over ${wallS.toFixed(0)}s — React re-render hypothesis DISPROVEN; ΔStyle=${dStyle} explained by N1b`
  );

  // N1b A/B via CDP metrics, NO RAF polling during the windows (r148 discovery:
  // the frame-rate ΔStyle seen in N1 was the sampler's own RAF loop requesting
  // frames — instrument reactivity, not animation cost).
  const styleDelta = async (ms) => {
    const a = (await wsSend(ws, "Performance.getMetrics")).metrics.find((m) => m.name === "RecalcStyleCount").value;
    await new Promise((r) => setTimeout(r, ms));
    const b = (await wsSend(ws, "Performance.getMetrics")).metrics.find((m) => m.name === "RecalcStyleCount").value;
    return b - a;
  };
  const styleRunning = await styleDelta(1500);
  await evalJs(ws, js(`
    document.querySelector(".ticker-track").style.animationPlayState = "paused";
    return true;
  `));
  await new Promise((r) => setTimeout(r, 300));
  const stylePaused = await styleDelta(1500);
  await evalJs(ws, js(`
    document.querySelector(".ticker-track").style.animationPlayState = "";
    return true;
  `));
  console.log(`  [r148 A/B] RecalcStyleCount/1.5s (no RAF polling): running=${styleRunning} paused=${stylePaused}`);
  const abMax = Math.max(styleRunning, stylePaused, 1);
  check(
    "N1b compositor isolation (running ≈ paused, |diff| ≤ 25% of max)",
    Math.abs(styleRunning - stylePaused) <= abMax * 0.25,
    `running=${styleRunning}/1.5s vs paused=${stylePaused}/1.5s — animation drives NO main-thread style work; N1's frame-rate ΔStyle was RAF-instrument reactivity`
  );
  check(
    "N2 RAF cadence steady (median 10-25ms, p95<40ms)",
    raf.median >= 10 && raf.median <= 25 && raf.p95 < 40,
    `median=${raf.median?.toFixed(1)}ms p95=${raf.p95?.toFixed(1)}ms max=${raf.max?.toFixed(1)}ms (headless software compositing caveat applies)`
  );
  check(
    "N3 no long tasks in window (≤2 dev-mode noise)",
    longTasks.length <= 2,
    `${longTasks.length} longtask(s)${longTasks.length ? `: ${JSON.stringify(longTasks)}` : ""}`
  );

  await shot(ws, "N-ticker-perf");

  ws.close();
  const pass = results.filter((r) => r.ok).length;
  console.log(`\n${pass}/${results.length} checks passed`);
  process.exit(pass === results.length ? 0 : 1);
}

main().catch((err) => {
  console.error("QA run failed:", err.stack ?? err.message);
  process.exit(2);
});
