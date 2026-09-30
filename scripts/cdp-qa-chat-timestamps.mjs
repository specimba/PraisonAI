// ─── QA — L-series (r146): chat timestamp polish ────────────────────────────
// r146 added fmtChatTime (today → bare HH:MM · yesterday → "Yesterday HH:MM"
// · older → "Mon D, HH:MM") + fmtChatTimeFull (absolute, for hover titles).
//   L1  fresh message (created seconds ago): assistant header shows bare
//       HH:MM and the span's title carries the FULL absolute timestamp.
//   L2  old message (injected directly into the store at a 40-day-old
//       timestamp): header switches to the dated form "Mon D, HH:MM".
//   L3  user bubble hover pill now contains a timestamp span (parity —
//       previously absent) with the same absolute title.
// Usage: node scripts/cdp-qa-chat-timestamps.mjs [baseUrl]

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

  // Force visible (fresh CDP tabs can start hidden).
  await evalJs(ws, js(`
    Object.defineProperty(document, "hidden", { get: () => false, configurable: true });
    Object.defineProperty(document, "visibilityState", { get: () => "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    return document.visibilityState;
  `));

  // Fresh chat so we control the message list.
  await evalJs(ws, js(`
    const btn = document.querySelector('button[aria-label="New chat"]');
    if (btn) btn.click();
    return true;
  `));
  await new Promise((r) => setTimeout(r, 600));

  // Send a message (stream may or may not resolve — we only need the ROWS).
  await evalJs(ws, js(`
    const ta = document.querySelector('textarea[aria-label^="Message"]');
    if (!ta) return "no-textarea";
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
    setter.call(ta, "timestamp polish check");
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    ta.focus();
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }));
    return true;
  `));
  // Wait for the assistant row (stream/lane may be slow) — L1 needs it.
  let l1 = { found: false };
  const l1start = Date.now();
  while (Date.now() - l1start < 30_000) {
    await new Promise((r) => setTimeout(r, 500));
    const probe = JSON.parse(await evalJs(ws, js(`
      const spans = [...document.querySelectorAll('[data-msg-id] span[title]')];
      const span = spans.find((s) => /text-\[11px\]/.test(s.className));
      return JSON.stringify({ found: !!span, text: span ? span.textContent.trim() : "", title: span ? span.title : "" });
    `)));
    if (probe.found) { l1 = probe; break; }
  }
  const freshOk =
    l1.found &&
    /^\d{1,2}:\d{2}$/.test(l1.text) &&       // today → bare time
    l1.title.includes(",") &&                 // absolute: date AND time
    /\d{4}/.test(l1.title);                   // includes a year
  check("L1 fresh msg: bare HH:MM + absolute title", freshOk, l1.found ? `text="${l1.text}" title="${l1.title}"` : `no assistant row in ${Math.round((Date.now() - l1start) / 1000)}s (lane unavailable — honest degrade)`);

  // Inject a 40-day-old assistant message directly into the store and let
  // React re-render — the header must switch to the dated form.
  const oldTs = Date.now() - 40 * 86_400_000;
  const injected = await evalJs(ws, js(`
    try {
      // persisted zustand store exposes itself via localStorage rehydration;
      // simplest reliable route: read the persisted conversations, patch the
      // last message's createdAt, write back, then reload.
      const key = Object.keys(localStorage).find((k) => k.includes("conversations"));
      if (!key) return "no-store";
      const raw = JSON.parse(localStorage.getItem(key));
      const state = raw?.state ?? raw;
      const convs = state.conversations ?? state.conversationsState?.conversations;
      if (!convs || !convs.length) return "no-convs";
      const last = convs[convs.length - 1];
      const msgs = last.messages ?? [];
      const asst = [...msgs].reverse().find((m) => m.role === "assistant");
      if (asst) asst.createdAt = ${oldTs};
      const user = [...msgs].reverse().find((m) => m.role === "user");
      if (user) user.createdAt = ${oldTs};
      localStorage.setItem(key, JSON.stringify(raw));
      return "patched:" + (asst ? "assistant" : "no-assistant") + (user ? "+user" : "");
    } catch (e) { return "err:" + e.message; }
  `));
  await wsSend(ws, "Page.navigate", { url: BASE });
  await new Promise((r) => setTimeout(r, 2500));
  await evalJs(ws, js(`
    Object.defineProperty(document, "hidden", { get: () => false, configurable: true });
    return true;
  `));

  // L2 reads EITHER the assistant header OR the user pill — both share the
  // same fmtChatTime code path, so the dated branch is proven either way.
  let l2 = { found: false };
  if (String(injected).includes("patched")) {
    l2 = JSON.parse(await evalJs(ws, js(`
      const spans = [...document.querySelectorAll('span[title]')];
      const span = spans.find((s) =>
        /text-\[11px\]/.test(s.className) ||
        (/tabular-nums/.test(s.className) && /^\w{3} \d{1,2},/.test(s.textContent.trim()))
      );
      if (!span) return JSON.stringify({ found: false });
      return JSON.stringify({ found: true, text: span.textContent.trim(), title: span.title });
    `)));
  }
  const dated = /^\w{3} \d{1,2}, \d{1,2}:\d{2}$/.test(l2.text ?? "");
  check(
    "L2 old msg: dated form",
    dated,
    l2.found ? `text="${l2.text}"` : `injection result: ${injected} (nothing patchable — honest degrade)`
  );

  // L3 — user bubble hover pill contains a timestamp span with absolute title.
  const l3 = JSON.parse(await evalJs(ws, js(`
    const pill = document.querySelector('div[role="toolbar"][aria-label="Message actions"]');
    if (!pill) return JSON.stringify({ found: false });
    const span = pill.querySelector("span[title]");
    return JSON.stringify({
      found: !!span,
      text: span ? span.textContent.trim() : "",
      title: span ? span.title : "",
    });
  `)));
  const pillOk = l3.found && l3.text.length > 0 && /\d{4}/.test(l3.title);
  check("L3 user pill timestamp parity", pillOk, l3.found ? `text="${l3.text}" title="${l3.title}"` : "no pill/timestamp found");

  await shot(ws, "L-chat-timestamps");

  ws.close();
  const pass = results.filter((r) => r.ok).length;
  console.log(`\n${pass}/${results.length} checks passed`);
  process.exit(pass === results.length ? 0 : 1);
}

main().catch((err) => {
  console.error("QA run failed:", err.stack ?? err.message);
  process.exit(2);
});
