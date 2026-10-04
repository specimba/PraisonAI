import { ensureChrome } from "./cdp-ensure-chrome.mjs";
// ─── QA — I-series (r141): ServerAutopilot poll is visibility-aware ─────────
// r141 changed the autopilot panel's 15s /api/automation/sync poll to skip
// ticks while the tab is hidden and to refetch immediately on return
// (before: ~240 wasted GETs/hour in a backgrounded tab + up-to-15s stale
// state on return). Asserts, against the live dev server:
//   I1  mount poll: opening Workflows fires ≥1 sync GET (mount fetch).
//   I2  visible interval: within ~16s another sync GET fires (interval alive
//       while visible).
//   I3  hidden pause: after forcing document.hidden=true + visibilitychange,
//       ~16s pass with ZERO new sync GETs (the waste is gone).
//   I4  return refresh: flipping back to visible fires a sync GET within
//       ~2.5s — no 15s stale window.
//   I5  panel data intact: the vault-lane chip (rendered only when state is
//       non-null) is present after the return refetch.
// Counts GETs by wrapping window.fetch BEFORE the view mounts (installed on
// about:blank… no — installed right after load, before the Workflows view is
// opened, so the mount poll is counted too).
// Usage: node scripts/cdp-qa-autopilot-poll.mjs [baseUrl]

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

async function waitFor(ws, expr, timeoutMs = 20_000, everyMs = 400) {
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

const clickByText = (label) => `
  (() => {
    const el = [...document.querySelectorAll('a,button,[role="button"],[role="tab"],[role="menuitem"]')]
      .find((e) => (e.textContent || "").trim().toLowerCase().startsWith(${JSON.stringify(label.toLowerCase())}) && e.offsetParent !== null);
    if (!el) return false;
    el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, view: window }));
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
    el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, view: window }));
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
    return true;
  })()`;

async function retryClick(ws, label, tries = 8, gapMs = 800) {
  for (let i = 0; i < tries; i++) {
    if (await evalJs(ws, clickByText(label))) return true;
    await new Promise((r) => setTimeout(r, gapMs));
  }
  return false;
}

const getSyncCount = `window.__syncGets ?? -1`;

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
  await waitFor(ws, `document.readyState === 'complete'`);
  await new Promise((r) => setTimeout(r, 2000));

  // Install the sync-GET counter BEFORE opening Workflows, so the mount poll
  // is counted. GETs only — runNow POSTs to run-now, not sync.
  await evalJs(ws, `
    (() => {
      window.__syncGets = 0;
      const orig = window.fetch;
      window.fetch = function (...args) {
        try {
          const u = typeof args[0] === "string" ? args[0] : (args[0]?.url ?? "");
          const m = (args[1]?.method ?? "GET").toUpperCase();
          if (u.includes("/api/automation/sync") && m === "GET") window.__syncGets++;
        } catch {}
        return orig.apply(this, args);
      };
      return true;
    })()`);

  if (!(await retryClick(ws, "Workflows"))) throw new Error("nav to Workflows failed");
  const mounted = await waitFor(
    ws,
    `document.querySelector('[aria-label="Server autopilot"]') !== null`,
    15_000
  );
  if (!mounted) throw new Error("ServerAutopilot panel never mounted");
  await new Promise((r) => setTimeout(r, 1200));

  // I1 — mount poll fired at least once. Note: headless tabs opened via
  // /json/new can start life "hidden" — and since r141 a hidden tab
  // deliberately SKIPS the mount poll (that's the feature). Force visible
  // first so I1 measures the visible path deterministically.
  await evalJs(ws, setHidden(false));
  const c1 = await evalJs(ws, getSyncCount);
  check("I1 mount poll fired", c1 >= 1, `sync GETs after mount = ${c1}`);

  // I2 — interval alive while visible: ≥1 more GET within ~16s
  const beforeVisible = c1;
  await new Promise((r) => setTimeout(r, 16_000));
  const c2 = await evalJs(ws, getSyncCount);
  check("I2 interval ticks while visible", c2 > beforeVisible, `${c2} GETs (was ${beforeVisible}) over 16s`);

  // I3 — hidden: zero GETs over ~16s despite two interval ticks
  const forced = await evalJs(ws, setHidden(true));
  if (forced !== "hidden") throw new Error("could not force visibilityState=hidden");
  const beforeHidden = c2;
  await new Promise((r) => setTimeout(r, 16_000));
  const c3 = await evalJs(ws, getSyncCount);
  check("I3 hidden tab makes zero sync GETs", c3 === beforeHidden, `${c3} GETs after 16s hidden (was ${beforeHidden})`);

  // I4 — return: immediate refetch within ~2.5s (no 15s stale window)
  const back = await evalJs(ws, setHidden(false));
  if (back !== "visible") throw new Error("could not force visibilityState=visible");
  let c4 = c3;
  for (let i = 0; i < 10 && c4 === c3; i++) {
    await new Promise((r) => setTimeout(r, 250));
    c4 = await evalJs(ws, getSyncCount);
  }
  check("I4 visible return refetches immediately", c4 > c3, `${c4} GETs within 2.5s of return (was ${c3})`);

  // I5 — panel data intact after the return refetch: the vault-lane chip
  // renders only when state is non-null.
  const chip = await waitFor(
    ws,
    `document.querySelector('[aria-label="Headless lane key status"]') !== null`,
    5_000
  );
  check("I5 panel state non-null after return", chip === true, "vault-lane chip rendered");

  await shot(ws, "I-autopilot-visibility-poll");

  ws.close();
  const pass = results.filter((r) => r.ok).length;
  console.log(`\n${pass}/${results.length} checks passed`);
  process.exit(pass === results.length ? 0 : 1);
}

main().catch((err) => {
  console.error("QA run failed:", err.message);
  process.exit(2);
});
