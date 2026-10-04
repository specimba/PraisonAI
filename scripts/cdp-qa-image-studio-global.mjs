#!/usr/bin/env node
// ─── Z-series (r247): Image Studio opens from the command palette anywhere ───
// Feature under test: the palette's "Open Image Studio…" action used to be a
// dead action on every non-chat view — the dialog only mounted inside
// chat-view, so the store flag flipped with nothing rendered. r247 moved the
// mount to the app root (mirroring GlobalSearchDialog).
//  Z1  from a NON-chat view (Agents), ⌘K/Ctrl+K opens the palette
//  Z2  typing "image" surfaces the "Open Image Studio…" item; clicking it
//      opens the Image Studio dialog WITHOUT leaving the Agents view
//  Z3  the dialog renders its real content (Grok Imagine 2 description)
//  Z4  no console errors during the suite
// Harness doctrine: launch chrome-headless-shell on :9222 in the SAME shell
// command; 1440x900; Radix interactions need the full pointer sequence.
// Usage: node scripts/cdp-qa-image-studio-global.mjs [baseUrl]
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

  // Z1 — land on a NON-chat view first, then open the palette with Ctrl+K
  // (inactive nav buttons carry an sr-only hint span — match by includes(),
  // exact-trim equality never matches: "AgentsCreate & manage AI agents")
  await evalJS(ws, `${POINTER_SEQ}([...document.querySelectorAll('aside nav button')].find((b) => b.textContent.includes("Agents")))`);
  await poll(ws, `document.querySelector("header h2")?.textContent`, (v) => v === "Agents", 8_000, "Agents view");
  await evalJS(ws, `document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true, cancelable: true }))`);
  await poll(ws, `!!document.querySelector('[cmdk-input]')`, Boolean, 6_000, "palette open");
  const Z1 = true;

  // Z2 — filter to the Image Studio item and click it
  await evalJS(ws, `(function(){
    const input = document.querySelector('[cmdk-input]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(input, "image");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  })()`);
  await sleep(300);
  const hit = await poll(
    ws,
    `JSON.stringify([...document.querySelectorAll('[cmdk-item], [role="option"]')].some((el) => el.textContent.includes("Open Image Studio")))`,
    (v) => JSON.parse(v) === true,
    6_000,
    "Open Image Studio item visible",
  );
  await evalJS(ws, `${POINTER_SEQ}([...document.querySelectorAll('[cmdk-item], [role="option"]')].find((el) => el.textContent.includes("Open Image Studio")))`);
  await poll(
    ws,
    `JSON.stringify({
      dialog: !!document.querySelector('[role="dialog"]'),
      studio: [...document.querySelectorAll('[role="dialog"] [data-slot="dialog-title"], [role="dialog"] h2, [role="dialog"] [class*="DialogTitle"], [role="dialog"] *')].some((el) => el.textContent?.trim() === "Image Studio"),
      view: document.querySelector("header h2")?.textContent ?? ""
    })`,
    (v) => { const o = JSON.parse(v); return o.dialog && o.studio && o.view === "Agents"; },
    8_000,
    "Image Studio dialog open, still on Agents",
  );
  const Z2 = { from: "Agents" };

  // Z3 — the dialog renders its real content (provider description).
  // Scan ALL dialogs: the palette's fading unmount remnant portals EARLIER in
  // DOM order than the studio, so querySelector (first match) can grab it.
  const desc = await poll(
    ws,
    `JSON.stringify([...document.querySelectorAll('[role="dialog"]')].some((d) => d.textContent.includes("Grok Imagine 2")))`,
    (v) => JSON.parse(v) === true,
    6_000,
    "dialog content",
  );
  // poll()'s want() predicate IS the assertion — capture success, not the
  // returned value (it is the raw STRING "true", not a boolean).
  const Z3 = true;

  const shot = await wsSend(ws, "Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(OUT_DIR, "z-series-image-studio-global.png"), Buffer.from(shot.data, "base64"));

  const Z4 = errors.length === 0;
  const results = [
    ["Z1 palette opens with Ctrl+K on Agents view", Z1, ""],
    ["Z2 palette action opens Image Studio, view stays", true, JSON.stringify(Z2)],
    ["Z3 dialog renders real content", Z3, ""],
    ["Z4 no console errors", Z4, errors.slice(0, 3).join(" | ")],
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
