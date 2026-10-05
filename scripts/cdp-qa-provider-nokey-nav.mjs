#!/usr/bin/env node
import { ensureChrome } from "./cdp-ensure-chrome.mjs";
// ─── Y-series (r246): TopBar provider dropdown "no key" click navigates ──────
// Feature under test: clicking a KEYLESS provider in the TopBar provider
// dropdown used to be a dead click (it even mutated the wrong store —
// setPaletteOpen, the command palette, not this dropdown). Now it navigates
// to Settings and raises an "Add your <provider> key" toast.
//  Y1  the dropdown opens from the TopBar badge (full pointer sequence —
//      Radix DropdownMenuTrigger opens on POINTERDOWN; synthetic click()
//      starves, harness lesson from the r150 era)
//  Y2  at least one "no key" item exists on a fresh profile; clicking it
//      closes the menu AND switches the view to Settings (header h2 text)
//  Y3  a sonner toast mentioning "Add your" appears
//  Y4  no console errors during the suite
// Harness doctrine: launch chrome-headless-shell on :9222 in the SAME shell
// command as this script (sandbox reaps processes between rounds); headless
// window 1440x900; fresh CDP tabs start HIDDEN — Page.bringToFront first.
// Usage: node scripts/cdp-qa-provider-nokey-nav.mjs [baseUrl]
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
  await ensureChrome();
  const list = await fetch("http://127.0.0.1:9222/json/version").then((r) => r.json()).catch(() => null);
  if (!list) throw new Error("chrome CDP not reachable on :9222 — launch chrome-headless-shell first (same shell command)");
  // r266: self-created tab (scan-reuse was a race — clientless targets are
  // reaped lazily by this shell; r265 finding).
  const tabRes = await fetch("http://127.0.0.1:9222/json/new", { method: "PUT" });
  if (!tabRes.ok) throw new Error(`/json/new failed: ${tabRes.status}`);
  const page = await tabRes.json();
  const ws = await connect(page.webSocketDebuggerUrl);
  // Note: connect() binds ws.onmessage for RPC; native WebSocket fires BOTH
  // the on* property and addEventListener listeners, so event taps below can
  // coexist with the RPC handler (do NOT null onmessage).
  const errors = [];

  await wsSend(ws, "Page.enable");
  await wsSend(ws, "Runtime.enable");
  await wsSend(ws, "Page.bringToFront").catch(() => {});
  await wsSend(ws, "Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await wsSend(ws, "Page.navigate", { url: BASE });

  // capture console errors while the suite runs
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.method === "Runtime.consoleAPICalled" && msg.params?.type === "error") {
      errors.push((msg.params.args ?? []).map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 200));
    }
    if (msg.method === "Runtime.exceptionThrown") {
      errors.push(String(msg.params?.exceptionDetails?.exception?.description ?? "exception").slice(0, 200));
    }
  });

  // wait for the app shell + TopBar dropdown trigger
  await poll(ws, `!!document.querySelector('header [aria-haspopup="menu"]')`, Boolean, 20_000, "TopBar badge");
  await sleep(1500); // let one-time intro effects settle

  // If the persisted view is already Settings, go back to Chat first so the
  // navigation assertion is meaningful.
  let h2 = await evalJS(ws, `document.querySelector("header h2")?.textContent ?? ""`);
  if (h2 === "Settings") {
    await evalJS(ws, `${POINTER_SEQ}([...document.querySelectorAll('aside nav button')].find((b) => b.textContent.includes("Chat")))`);
    await poll(ws, `document.querySelector("header h2")?.textContent`, (v) => v === "Chat", 8_000, "back to Chat");
    h2 = "Chat";
  }
  const beforeTitle = h2;

  // Y1 — open the dropdown via the pointer sequence
  await evalJS(ws, `${POINTER_SEQ}(document.querySelector('header [aria-haspopup="menu"]'))`);
  await poll(ws, `!!document.querySelector('[role="menu"]')`, Boolean, 6_000, "provider menu open");
  const Y1 = true;

  // Y2 — click the first "no key" item; expect menu closed + Settings view
  const items = await evalJS(ws, `JSON.stringify([...document.querySelectorAll('[role="menuitem"]')]
    .filter((el) => el.textContent.includes("no key"))
    .map((el) => el.textContent.replace("no key", "").trim()))`);
  const noKeyItems = JSON.parse(items);
  if (!noKeyItems.length) throw new Error("no keyless provider items rendered on a fresh profile — cannot exercise the fix");
  const providerName = noKeyItems[0];
  await evalJS(ws, `${POINTER_SEQ}([...document.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent.includes("no key")))`);
  await poll(
    ws,
    `JSON.stringify({ title: document.querySelector("header h2")?.textContent ?? "", menuGone: !document.querySelector('[role="menu"]') })`,
    (v) => { const o = JSON.parse(v); return o.title === "Settings" && o.menuGone; },
    8_000,
    "navigate to Settings + menu closed",
  );
  const Y2 = { providerName, beforeTitle, afterTitle: "Settings" };

  // Y3 — sonner toast pointing at the key's home
  await poll(
    ws,
    `JSON.stringify([...document.querySelectorAll('[data-sonner-toast]')].map((t) => t.textContent))`,
    (v) => JSON.parse(v).some((t) => t.includes("Add your")),
    8_000,
    "Add-your-key toast",
  );
  const Y3 = true;

  const shot = await wsSend(ws, "Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(OUT_DIR, "y-series-provider-nokey-nav.png"), Buffer.from(shot.data, "base64"));

  const Y4 = errors.length === 0;
  const results = [
    ["Y1 dropdown opens via pointer sequence", Y1, ""],
    ["Y2 no-key click navigates to Settings", true, JSON.stringify(Y2)],
    ["Y3 'Add your … key' toast appears", Y3, ""],
    ["Y4 no console errors", Y4, errors.slice(0, 3).join(" | ")],
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
