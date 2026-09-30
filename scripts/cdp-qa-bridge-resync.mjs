// ─── QA — J-series (r144): bridge heartbeat liveness + resync-on-return ─────
// r144 added a visibilitychange→visible resync to the AutomationBridge's 60s
// POST /api/automation/sync heartbeat. The bridge's semantics are the MIRROR
// of the r141 autopilot poll:
//   J1  visible: ≥1 heartbeat POST within ~65s (the 60s interval ticks).
//   J2  forced hidden: ≥1 heartbeat POST STILL within ~65s — the liveness
//       claim must survive in hidden tabs (suppressing it would hand
//       schedules to the shared server lane on a mere window switch).
//   J3  flip back to visible: a heartbeat POST lands within ~3s — the new
//       resync (before r144: up to 60s of stale registration, during which
//       the headless lane could claim a due run).
// Counts POSTs by wrapping window.fetch right after load (bridge mounts at
// app root, before any view click).
// Usage: node scripts/cdp-qa-bridge-resync.mjs [baseUrl]

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

// ── CDP harness (r139/r140 pattern) ─────────────────────────────────────────
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

const setHidden = (hidden) => `
  (() => {
    Object.defineProperty(document, "hidden", {
      get: () => ${hidden ? "true" : "false"},
      configurable: true,
    });
    Object.defineProperty(document, "visibilityState", {
      get: () => ${hidden ? '"hidden"' : '"visible"'},
      configurable: true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
    return document.visibilityState;
  })()`;

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
  await evalJs(ws, `document.readyState === 'complete' || true`);
  await new Promise((r) => setTimeout(r, 2500));

  // POST counter for the bridge heartbeat (GETs from the autopilot poll etc.
  // are NOT counted — only the bridge's POSTs).
  await evalJs(ws, `
    (() => {
      window.__bridgePosts = 0;
      const orig = window.fetch;
      window.fetch = function (...args) {
        try {
          const u = typeof args[0] === "string" ? args[0] : (args[0]?.url ?? "");
          const m = (args[1]?.method ?? "GET").toUpperCase();
          if (u.includes("/api/automation/sync") && m === "POST") window.__bridgePosts++;
        } catch {}
        return orig.apply(this, args);
      };
      return true;
    })()`);

  // Make sure the tab counts as visible (fresh CDP tabs can start hidden),
  // then measure the heartbeat cadence from a clean state.
  await evalJs(ws, setHidden(false));
  await new Promise((r) => setTimeout(r, 1_000));

  // J1 — visible: heartbeat ticks within ~65s
  const j1start = Date.now();
  let c = await evalJs(ws, `window.__bridgePosts`);
  let fired = false;
  while (Date.now() - j1start < 65_000) {
    await new Promise((r) => setTimeout(r, 1_000));
    c = await evalJs(ws, `window.__bridgePosts`);
    if (c >= 1) { fired = true; break; }
  }
  check("J1 heartbeat POSTs while visible", fired, `${c} POST(s) in ${Math.round((Date.now() - j1start) / 1000)}s`);

  // J2 — hidden: heartbeat KEEPS posting (liveness claim survives)
  const forced = await evalJs(ws, setHidden(true));
  if (forced !== "hidden") throw new Error("could not force visibilityState=hidden");
  const j2start = Date.now();
  const beforeHidden = c;
  let afterHidden = c;
  fired = false;
  while (Date.now() - j2start < 65_000) {
    await new Promise((r) => setTimeout(r, 1_000));
    c = await evalJs(ws, `window.__bridgePosts`);
    if (c > beforeHidden) { fired = true; afterHidden = c; break; }
  }
  check("J2 heartbeat KEEPS running while hidden", fired, `${afterHidden} POST(s) while hidden (was ${beforeHidden}) — liveness claim intact`);

  // J3 — return to visible: resync POST within ~3s (the r144 change)
  const back = await evalJs(ws, setHidden(false));
  if (back !== "visible") throw new Error("could not force visibilityState=visible");
  const j3start = Date.now();
  fired = false;
  while (Date.now() - j3start < 3_000) {
    await new Promise((r) => setTimeout(r, 250));
    c = await evalJs(ws, `window.__bridgePosts`);
    if (c > afterHidden) { fired = true; break; }
  }
  const within = Math.round((Date.now() - j3start) / 100) / 10;
  check("J3 resync fires immediately on return", fired, `POST within ${within}s of becoming visible`);

  await shot(ws, "J-bridge-resync");

  ws.close();
  const pass = results.filter((r) => r.ok).length;
  console.log(`\n${pass}/${results.length} checks passed`);
  process.exit(pass === results.length ? 0 : 1);
}

main().catch((err) => {
  console.error("QA run failed:", err.message);
  process.exit(2);
});
