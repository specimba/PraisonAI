// ─── QA — Q-series (r151): ticker dark-recovery retry loop ──────────────────
// r151 shipped a short-backoff retry (5s/15s/60s) for failed tracker fetches.
// Before the fix, a failed FIRST fetch left the strip dark (no localStorage
// cache → ModelTicker renders null) until the next 15-min poll.
//   Q1  tracker fetch blocked pre-boot + cache cleared → strip stays ABSENT
//       at t=3s (the dark state, asserted to exist)
//   Q2  blocker lifted → the 5s retry timer recovers the strip by t=9s —
//       the exact path that did not exist before r151
//   Q3  recovery is real: strip carries the "synced" chip + "Model Tracker"
//       trigger button
// Uses Page.addScriptToEvaluateOnNewDocument so the blocker + cache clear run
// BEFORE any app script (a post-load override cannot reproduce boot failure).
// Usage: node scripts/cdp-qa-ticker-retry.mjs [baseUrl]

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

const BLOCKER = `
  window.__blockTracker = true;
  (function () {
    const orig = window.fetch.bind(window);
    window.fetch = function (input, init) {
      const url = typeof input === "string" ? input : (input && input.url) || "";
      if (window.__blockTracker && String(url).indexOf("/api/tracker") !== -1) {
        return Promise.resolve(new Response(JSON.stringify({ error: "blocked by QA" }), { status: 503 }));
      }
      return orig(input, init);
    };
  })();
  try { localStorage.removeItem("praison-tracker-cache"); } catch (e) {}
`;

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
  await wsSend(ws, "Page.addScriptToEvaluateOnNewDocument", { source: BLOCKER });
  await wsSend(ws, "Page.navigate", { url: BASE });
  await evalJs(ws, "document.title");
  await sleep(3000);

  const stripState = () => evalJs(ws, js(`
    const strip = document.querySelector('[role="region"][aria-label="Model tracker ticker"]');
    return JSON.stringify({
      present: !!strip,
      blockerAlive: window.__blockTracker === true,
      cacheEmpty: localStorage.getItem("praison-tracker-cache") === null,
    });
  `));

  // Q1: dark state exists — fetch failing + no cache → strip absent.
  const q1 = JSON.parse(await stripState());
  check(
    "Q1 dark state: blocked fetch + empty cache → strip absent at 3s",
    q1.present === false && q1.blockerAlive && q1.cacheEmpty,
    `present=${q1.present} blockerAlive=${q1.blockerAlive} cacheEmpty=${q1.cacheEmpty}`
  );

  // Q2: lift the blocker; the 5s retry timer (armed at boot failure) must
  // recover the strip — the exact behavior that did not exist before r151.
  await evalJs(ws, js(`window.__blockTracker = false; return true;`));
  const t0 = Date.now();
  let recovered = false;
  for (let i = 0; i < 16; i++) {
    await sleep(500);
    const s = JSON.parse(await stripState());
    if (s.present) { recovered = true; break; }
  }
  const recoveryMs = Date.now() - t0;
  check(
    "Q2 retry loop recovers the strip after blocker lifted",
    recovered && recoveryMs < 9000,
    `recovered=${recovered} in ~${recoveryMs}ms (5s backoff + paint; pre-r151 this waited 15min)`
  );

  // Q3: the recovered strip is the real thing — trigger + synced chip.
  const q3 = JSON.parse(await evalJs(ws, js(`
    const strip = document.querySelector('[role="region"][aria-label="Model tracker ticker"]');
    return JSON.stringify({
      trigger: !!strip?.querySelector("button"),
      syncedText: (strip?.textContent ?? "").includes("synced"),
    });
  `)));
  check(
    "Q3 recovered strip is functional (trigger + synced chip)",
    q3.trigger && q3.syncedText,
    `trigger=${q3.trigger} syncedText=${q3.syncedText}`
  );

  await shot(ws, "Q-ticker-retry");

  ws.close();
  const pass = results.filter((r) => r.ok).length;
  console.log(`\n${pass}/${results.length} checks passed`);
  process.exit(pass === results.length ? 0 : 1);
}

main().catch((err) => {
  console.error("QA run failed:", err.stack ?? err.message);
  process.exit(2);
});
