import { ensureChrome } from "./cdp-ensure-chrome.mjs";
// ─── QA — O-series (r150): workflow editor dialog keyboard behavior ─────────
// The editor dialog is the most complex surface never live-QA'd. The r150
// a11y sweep (scripts/a11y-icon-button-audit.mjs) found 0 defects statically;
// this script verifies the dynamic behaviors a static sweep cannot:
//   O1  "New Workflow" opens the dialog AND focus lands inside it
//   O2  Tab ×8 stays trapped inside the dialog (Radix focus trap holds)
//   O3  Escape closes the dialog
//   O4  "Add step" then the step movers carry accessible names in live DOM
//       (the r150 code-level finding, verified against the rendered tree)
// Usage: node scripts/cdp-qa-editor-kbd.mjs [baseUrl]

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

async function key(ws, keyName, code, keyCode) {
  await wsSend(ws, "Input.dispatchKeyEvent", { type: "keyDown", key: keyName, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
  await wsSend(ws, "Input.dispatchKeyEvent", { type: "keyUp", key: keyName, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
}

async function shot(ws, name) {
  const r = await wsSend(ws, "Page.captureScreenshot", { format: "png" });
  const file = path.join(OUT_DIR, `${name}.png`);
  fs.writeFileSync(file, Buffer.from(r.data, "base64"));
  console.log(`  📸 ${file}`);
}

const js = (s) => `(function(){ ${s} })()`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

  // Land on the Workflows view via the app's own nav, then open the editor.
  // (r150 probe lesson: sidebar buttons bundle title+desc, e.g.
  // "WorkflowsMulti-agent pipelines" — match by prefix, not equality.)
  const nav = await evalJs(ws, js(`
    const btns = [...document.querySelectorAll("button")];
    const navWf = btns.find((b) => (b.textContent ?? "").trim().startsWith("Workflows"));
    if (navWf) { navWf.click(); return "nav-clicked"; }
    return "nav-not-found";
  `));
  await sleep(1200);
  console.log(`  [nav] ${nav}`);

  // O1: open the editor dialog, focus must land inside it.
  await evalJs(ws, js(`
    const b = [...document.querySelectorAll('button[aria-label="New Workflow"]')][0];
    if (!b) throw new Error("New Workflow button not found");
    b.click();
    return true;
  `));
  await sleep(800);
  const o1 = JSON.parse(await evalJs(ws, js(`
    const dlg = document.querySelector('[role="dialog"]');
    const title = dlg?.querySelector("h2, [data-slot='dialog-title']")?.textContent ?? "";
    const ae = document.activeElement;
    return JSON.stringify({
      open: !!dlg,
      title,
      focusInside: !!dlg && dlg.contains(ae),
      focusTag: ae?.tagName ?? null,
    });
  `)));
  check(
    "O1 dialog opens + focus lands inside",
    o1.open && o1.focusInside,
    `title="${o1.title}" focusIn=${o1.focusInside} activeElement=${o1.focusTag}`
  );

  // O2: Tab ×8 must stay inside the dialog.
  for (let i = 0; i < 8; i++) await key(ws, "Tab", "Tab", 9);
  await sleep(200);
  const o2 = JSON.parse(await evalJs(ws, js(`
    const dlg = document.querySelector('[role="dialog"]');
    return JSON.stringify({ stillInside: !!dlg && dlg.contains(document.activeElement) });
  `)));
  check("O2 Tab×8 focus trapped inside dialog", o2.stillInside, `stillInside=${o2.stillInside}`);

  // O4 first (dialog open): add a step, assert mover accessible names.
  await evalJs(ws, js(`
    const add = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Add step");
    if (!add) throw new Error("Add step button not found");
    add.click();
    return true;
  `));
  await sleep(400);
  const o4 = JSON.parse(await evalJs(ws, js(`
    const dlg = document.querySelector('[role="dialog"]');
    const named = [...dlg.querySelectorAll('button[aria-label]')]
      .map((b) => b.getAttribute("aria-label"))
      .filter((l) => /^Move step|^Remove step/.test(l));
    return JSON.stringify({ count: named.length, names: named.slice(0, 3) });
  `)));
  check(
    "O4 step movers carry accessible names in live DOM",
    o4.count >= 2,
    `${o4.count} named mover(s): ${JSON.stringify(o4.names)}`
  );

  // O3: Escape closes the dialog.
  await key(ws, "Escape", "Escape", 27);
  await sleep(500);
  const o3 = JSON.parse(await evalJs(ws, js(`return JSON.stringify({ gone: !document.querySelector('[role="dialog"]') });`)));
  check("O3 Escape closes the dialog", o3.gone, `dialogGone=${o3.gone}`);

  await shot(ws, "O-editor-kbd");

  ws.close();
  const pass = results.filter((r) => r.ok).length;
  console.log(`\n${pass}/${results.length} checks passed`);
  process.exit(pass === results.length ? 0 : 1);
}

main().catch((err) => {
  console.error("QA run failed:", err.stack ?? err.message);
  process.exit(2);
});
