// ─── QA — M-series (r147): sidebar list timestamps ──────────────────────────
// r147 added fmtListTime: sidebar conversation rows show relative time while
// fresh (<24h) and a short date ("Sep 27") when older; each row time now also
// carries an absolute `title` (the pre-r147 span had NO title attribute).
//   M1  at least one sidebar row time span with a title attr exists and its
//       text matches a plausible fmtListTime output (relative OR short date).
//   M2  the title is the full absolute timestamp (contains a year).
// Usage: node scripts/cdp-qa-sidebar-timestamps.mjs [baseUrl]

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
  await new Promise((r) => setTimeout(r, 1500));

  await evalJs(ws, js(`
    Object.defineProperty(document, "hidden", { get: () => false, configurable: true });
    Object.defineProperty(document, "visibilityState", { get: () => "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    return document.visibilityState;
  `));

  // Sidebar rows: spans WITH title attr (the r147 marker) whose text looks
  // like fmtListTime output. Relative: "just now" / "5m ago" / "23h ago".
  // Dated: "Sep 27". Then M2: title carries the absolute (year included).
  const probe = JSON.parse(await evalJs(ws, js(`
    const spans = [...document.querySelectorAll('span[title]')].filter((s) => {
      const t = s.textContent.trim();
      return /^just now$|^\\d{1,2}[smh] ago$|^\\d{1,2}h ago$|^\\w{3} \\d{1,2}$|^\\d{1,2}:\\d{2}/.test(t)
        && /\\d{4}/.test(s.title);
    });
    return JSON.stringify({
      count: spans.length,
      samples: spans.slice(0, 3).map((s) => s.textContent.trim() + " | " + s.title),
    });
  `)));
  check(
    "M1 sidebar row times with title attr + plausible text",
    probe.count >= 1,
    probe.count >= 1 ? `${probe.count} row(s); sample: ${probe.samples[0]}` : "no titled row-time spans found"
  );
  const m2ok = probe.count >= 1 && probe.samples.every((s) => /\d{4}/.test(s.split(" | ")[1] ?? ""));
  check("M2 title is absolute (year present)", m2ok, probe.samples.join(" ;; "));

  await shot(ws, "M-sidebar-timestamps");

  ws.close();
  const pass = results.filter((r) => r.ok).length;
  console.log(`\n${pass}/${results.length} checks passed`);
  process.exit(pass === results.length ? 0 : 1);
}

main().catch((err) => {
  console.error("QA run failed:", err.stack ?? err.message);
  process.exit(2);
});
