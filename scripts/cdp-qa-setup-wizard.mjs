#!/usr/bin/env node
import { ensureChrome } from "./cdp-ensure-chrome.mjs";
// ─── W-series (r256): setup wizard step flow ────────────────────────────────
// Closes the verification gap flagged in r255: the setup wizard had no
// dedicated CDP suite (Enter/Back were verified by the IME guard + tsc +
// the adjacent Y-suite boot check only). r255 shipped two behaviors there:
// IME-safe Enter-to-submit on #wizard-key / #wizard-account, and a Back
// button whose tautological condition (guide.length >= 0) became real.
//  W1  the #/setup hash route opens the wizard (title renders)
//  W2  step 0 → picking the first provider WITHOUT a saved key lands on the
//      "Register (2-3 min)" step (pickProvider's fresh-key path)
//  W3  "I have my key" → Connect step renders #wizard-key
//  W4  IME safety: Enter keydown with isComposing=true does NOT submit
//      (no "Paste your API key first" toast) — the r244/r245 doctrine
//  W5  Enter-to-submit: Enter with isComposing=false + empty key → the
//      "Paste your API key first" toast appears (validateAndFinish ran)
//  W6  Back from the Connect step returns to "Register (2-3 min)"
//      (guide preserved for providers that have one — r255 contract)
//  W7  no console errors during the suite
// Provider pick note: localStorage vault-clearing is FUTILE by design —
// DEFAULT_SETTINGS preseeds a vyce key (constants.ts PRESEED_PROVIDER_KEYS)
// and the settings persist's deep-merge (stores.ts) re-injects preseeded
// keys on every rehydrate. The suite therefore picks a provider row that
// does NOT show the wizard's "key saved" marker, which is deterministic.
// Harness doctrine: ensureChrome() self-heals the 9222 chrome (r254); headless
// window 1440x900; fresh CDP tabs start HIDDEN — Page.bringToFront first.
// Usage: node scripts/cdp-qa-setup-wizard.mjs [baseUrl]
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
    let v;
    try {
      v = await evalJS(ws, expr);
    } catch {
      // navigation/reload windows can make evaluate throw — treat as "not yet"
      if (Date.now() - t0 > timeoutMs) throw new Error(`poll timeout: ${label} (eval kept throwing)`);
      await sleep(400);
      continue;
    }
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

// Fires a keydown Enter on el with a controlled isComposing flag. The
// KeyboardEvent constructor cannot set isComposing (read-only UIEvent
// property), so the instance shadows it via defineProperty — React's
// synthetic e.nativeEvent IS this dispatched event, so the r255 handler's
// e.nativeEvent.isComposing read observes exactly what we set.
const FIRE_ENTER = `(function fireEnter(el, composing){
  if (!el) return false;
  const ev = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
  Object.defineProperty(ev, "isComposing", { get: () => composing });
  el.dispatchEvent(ev);
  return true;
})`;

const dialogOpen = `JSON.stringify(
  [...document.querySelectorAll('[role="dialog"]')].some((d) => d.textContent.includes("Free frontier key"))
)`;
const toastTexts = `JSON.stringify([...document.querySelectorAll('[data-sonner-toast]')].map((t) => t.textContent))`;

async function main() {
  await ensureChrome();
  const ver = await fetch("http://127.0.0.1:9222/json/version").then((r) => r.json()).catch(() => null);
  if (!ver) throw new Error("chrome CDP not reachable on :9222 — ensureChrome() failed (see its explicit error)");
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

  // wait for the app shell + one-time intro effects
  await poll(ws, `!!document.querySelector('header [aria-haspopup="menu"]')`, Boolean, 20_000, "app shell");
  await sleep(1500);

  // W1 — open the wizard via the #/setup hash route (mount-time applyHashRoute
  // may have already opened it if a previous run left the hash in place; the
  // wizard strips its own hash on close, so setting it fires hashchange).
  const alreadyOpen = JSON.parse(await evalJS(ws, dialogOpen));
  if (!alreadyOpen) await evalJS(ws, `location.hash = "#/setup"; true`);
  await poll(ws, dialogOpen, (v) => JSON.parse(v) === true, 8_000, "wizard opens via #/setup");
  const W1 = { viaHash: true, alreadyOpen };

  // W2 — pick the first provider row WITHOUT the "key saved" marker (the
  // wizard renders that marker per row; preseeded/saved providers skip the
  // Register step by design) → fresh-key provider lands on Register.
  const picked = await evalJS(ws, `(() => {
    const dlg = [...document.querySelectorAll('[role="dialog"]')].find((d) => d.textContent.includes("Free frontier key"));
    if (!dlg) return "no-dialog";
    const rows = [...dlg.querySelectorAll("button")].filter((b) => b.querySelector("span.font-semibold") && b.closest(".max-h-80"));
    if (!rows.length) return "no-rows";
    const fresh = rows.find((b) => !b.textContent.includes("key saved"));
    if (!fresh) return "all-keyed";
    return fresh.querySelector("span.font-semibold").textContent;
  })()`);
  if (picked === "no-dialog" || picked === "no-rows" || picked === "all-keyed") throw new Error(`cannot pick a fresh provider: ${picked}`);
  await evalJS(ws, `${POINTER_SEQ}([...document.querySelectorAll('[role="dialog"] button')].find((b) => b.querySelector("span.font-semibold") && b.closest(".max-h-80") && !b.textContent.includes("key saved")))`);
  await poll(
    ws,
    `JSON.stringify([...document.querySelectorAll('[role="dialog"] p')].map((p) => p.textContent).join("|"))`,
    (v) => v.includes("Register (2-3 min)"),
    8_000,
    "lands on Register step",
  );
  const W2 = { provider: picked, step: "Register (2-3 min)" };

  // W3 — forward to the Connect step
  await evalJS(ws, `${POINTER_SEQ}([...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent.includes("I have my key")))`);
  await poll(ws, `!!document.querySelector('#wizard-key')`, Boolean, 8_000, "#wizard-key rendered");
  const W3 = true;

  // W4 — IME safety: composing Enter must NOT submit
  const preExisting = JSON.parse(await evalJS(ws, toastTexts));
  if (preExisting.some((t) => t.includes("Paste your API key first"))) {
    throw new Error("a 'Paste your API key first' toast already exists before W4 — absence check would be meaningless");
  }
  await evalJS(ws, `${FIRE_ENTER}(document.querySelector('#wizard-key'), true)`);
  await sleep(1500);
  const afterComposing = JSON.parse(await evalJS(ws, toastTexts));
  const W4 = !afterComposing.some((t) => t.includes("Paste your API key first"));

  // W5 — Enter-to-submit: plain Enter with an empty key → validation toast
  await evalJS(ws, `${FIRE_ENTER}(document.querySelector('#wizard-key'), false)`);
  await poll(ws, toastTexts, (v) => JSON.parse(v).some((t) => t.includes("Paste your API key first")), 8_000, "validation toast after plain Enter");
  const W5 = true;

  const shot = await wsSend(ws, "Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(OUT_DIR, "w-series-setup-wizard.png"), Buffer.from(shot.data, "base64"));

  // W6 — Back from Connect returns to the registration step (guide preserved)
  await evalJS(ws, `${POINTER_SEQ}([...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent.includes("Back")))`);
  await poll(
    ws,
    `JSON.stringify([...document.querySelectorAll('[role="dialog"] p')].map((p) => p.textContent).join("|"))`,
    (v) => v.includes("Register (2-3 min)"),
    8_000,
    "Back returns to Register",
  );
  const W6 = true;

  const W7 = errors.length === 0;
  const results = [
    ["W1 #/setup opens the wizard", true, JSON.stringify(W1)],
    ["W2 first provider → Register step", true, JSON.stringify(W2)],
    ["W3 'I have my key' → #wizard-key", W3, ""],
    ["W4 composing Enter does NOT submit", W4, afterComposing.filter((t) => t.includes("Paste")).join(" | ")],
    ["W5 plain Enter submits (toast shown)", W5, ""],
    ["W6 Back → Register step", W6, ""],
    ["W7 no console errors", W7, errors.slice(0, 3).join(" | ")],
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
