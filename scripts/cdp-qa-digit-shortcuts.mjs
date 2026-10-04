#!/usr/bin/env node
// ─── D-series (r249): ⌘/Ctrl+1…5 follow SIDEBAR POSITION ────────────────────
// r249 changed VIEW_ORDER in src/lib/use-shortcuts.ts from the old internal
// order [chat, agents, workflows, SETTINGS, RADAR] to sidebar order
// [chat, agents, workflows, RADAR, SETTINGS] so that ⌘N opens the Nth sidebar
// item; the command palette's nav labels (Radar ⌘4 / Settings ⌘5) were swapped
// to match. This suite pins the new mapping end-to-end.
//  D1  Ctrl+4 from Chat lands on Trend Radar (sidebar item #4)
//  D2  Ctrl+5 from Radar lands on Settings (sidebar item #5)
//  D3  the command palette labels are honest: Radar item shows ⌘4, Settings ⌘5
//  D4  no console errors during the suite
// Harness doctrine: launch chrome-headless-shell on :9222 in the SAME shell
// command; 1440x900. Synthetic KeyboardEvents dispatched on document.body
// bubble to the window listener and BYPASS Chrome's real Ctrl+1-8 tab
// reservation, so the page-level handler is fully testable headlessly (the
// real-browser caveat stays documented in README).
// Usage: node scripts/cdp-qa-digit-shortcuts.mjs [baseUrl]
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function evalJS(ws, expression) {
  const r = await wsSend(ws, "Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) {
    throw new Error("eval failed: " + (r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails)).slice(0, 400));
  }
  return r.result?.value;
}
async function poll(ws, expr, want, timeoutMs, label) {
  const t0 = Date.now();
  for (;;) {
    const v = await evalJS(ws, expr);
    if (want(v)) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`poll timeout: ${label} (last=${JSON.stringify(v)?.slice(0, 200)})`);
    await sleep(400);
  }
}

// Synthetic Ctrl+<digit> on document.body — bubbles to the window keydown
// listener in use-shortcuts (target = body, so the inField guard passes).
const CTRL_DIGIT = (digit) => `document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "${digit}", ctrlKey: true, bubbles: true, cancelable: true }))`;

const POINTER_SEQ = `(function firePointer(el){
  if (!el) return false;
  const r = el.getBoundingClientRect();
  const x = r.left + r.width / 2, y = r.top + r.height / 2;
  const down = { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, pointerType: "mouse", isPrimary: true, button: 0, buttons: 1 };
  const up = { ...down, buttons: 0 };
  el.dispatchEvent(new PointerEvent("pointerdown", down));
  el.dispatchEvent(new MouseEvent("mousedown", down));
  el.dispatchEvent(new PointerEvent("pointerup", up));
  el.dispatchEvent(new MouseEvent("mouseup", up));
  el.dispatchEvent(new MouseEvent("click", up));
  return true;
})`;

async function main() {
  const list = await fetch("http://127.0.0.1:9222/json/version").then((r) => r.json()).catch(() => null);
  if (!list) throw new Error("chrome CDP not reachable on :9222 — launch chrome-headless-shell first (same shell command)");
  const targets = await fetch("http://127.0.0.1:9222/json/list").then((r) => r.json());
  const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
  if (!page) throw new Error("no page target");
  const ws = await connect(page.webSocketDebuggerUrl);
  const errors = [];

  await wsSend(ws, "Page.enable");
  await wsSend(ws, "Runtime.enable");
  await wsSend(ws, "Page.bringToFront").catch(() => {});
  await wsSend(ws, "Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await wsSend(ws, "Page.navigate", { url: BASE });

  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.method === "Runtime.consoleAPICalled" && msg.params?.type === "error") {
      errors.push((msg.params.args ?? []).map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 200));
    }
    if (msg.method === "Runtime.exceptionThrown") {
      errors.push(String(msg.params?.exceptionDetails?.exception?.description ?? "exception").slice(0, 200));
    }
  });

  await poll(ws, `!!document.querySelector('aside nav button')`, Boolean, 20_000, "app shell");
  await sleep(1500);

  // Normalize: the persisted view may be anything — land on Chat first so D1's
  // "Ctrl+4 → Radar" assertion can't pass by accident (Y-suite lesson).
  await evalJS(ws, `${POINTER_SEQ}([...document.querySelectorAll('aside nav button')].find((b) => b.textContent.includes("Chat")))`);
  await poll(ws, `document.querySelector("header h2")?.textContent`, (v) => v === "Chat", 8_000, "Chat view");

  // D1 — Ctrl+4 → Trend Radar (sidebar position 4 under the NEW mapping)
  await evalJS(ws, CTRL_DIGIT("4"));
  await poll(ws, `document.querySelector("header h2")?.textContent`, (v) => v === "Trend Radar", 8_000, "Ctrl+4 → Trend Radar");
  const D1 = true;

  // D2 — Ctrl+5 → Settings (sidebar position 5; also proves the old
  // Ctrl+4=Settings mapping is gone since we're ON Radar now)
  await evalJS(ws, CTRL_DIGIT("5"));
  await poll(ws, `document.querySelector("header h2")?.textContent`, (v) => v === "Settings", 8_000, "Ctrl+5 → Settings");
  const D2 = true;

  // D3 — palette labels are honest: filter to "radar", the item must show ⌘4;
  // then "settings" must show ⌘5. (Value-setter dance into the cmdk input.)
  await evalJS(ws, `document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true, cancelable: true }))`);
  await poll(ws, `!!document.querySelector('[cmdk-input]')`, Boolean, 6_000, "palette open");
  const labelCheck = await poll(
    ws,
    `(function(){
      const input = document.querySelector('[cmdk-input]');
      if (!input) return null;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      const read = () => [...document.querySelectorAll('[cmdk-item], [role="option"]')].map((el) => el.textContent);
      setter.call(input, "radar");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return new Promise((res) => setTimeout(() => {
        const radarHit = read().some((t) => t.includes("Radar") && t.includes("\\u23184"));
        setter.call(input, "settings");
        input.dispatchEvent(new Event("input", { bubbles: true }));
        setTimeout(() => {
          const settingsHit = read().some((t) => t.includes("Settings") && t.includes("\\u23185"));
          setter.call(input, "");
          input.dispatchEvent(new Event("input", { bubbles: true }));
          res(JSON.stringify({ radarHit, settingsHit }));
        }, 350);
      }, 350));
    })()`,
    (v) => { const o = JSON.parse(v); return o.radarHit && o.settingsHit; },
    10_000,
    "palette shortcut labels Radar ⌘4 / Settings ⌘5",
  );
  const D3 = true;

  const shot = await wsSend(ws, "Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(OUT_DIR, "d-series-digit-shortcuts.png"), Buffer.from(shot.data, "base64"));

  const D4 = errors.length === 0;
  const results = [
    ["D1 Ctrl+4 lands on Trend Radar (sidebar #4)", D1, ""],
    ["D2 Ctrl+5 lands on Settings (sidebar #5)", D2, ""],
    ["D3 palette labels honest (Radar ⌘4 / Settings ⌘5)", D3, String(labelCheck)],
    ["D4 no console errors", D4, errors.slice(0, 3).join(" | ")],
  ];
  let pass = 0;
  for (const [name, ok, detail] of results) {
    if (ok) pass++;
    console.log(`${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
  }
  console.log(`SUMMARY: ${pass} passed, ${results.length - pass} failed`);
  process.exit(pass === results.length ? 0 : 1);
}

main().catch((e) => {
  console.error(String(e?.stack ?? e).split("\n").slice(0, 6).join("\n"));
  console.error("SUMMARY: 0 passed, 1 failed");
  process.exit(1);
});
