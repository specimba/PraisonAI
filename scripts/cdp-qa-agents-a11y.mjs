// ─── QA — H-series (r140): Agent card keyboard a11y ─────────────────────────
// r140 made the agent roster cards keyboard-operable: the clickable Card was
// a bare div (cursor-pointer + onClick only) — invisible to keyboard users
// and screen readers. Now: role="button" + tabIndex=0 + Enter/Space handler +
// focus-visible ring + aria-label. Asserts, against the live dev server:
//   H1  cards render as role="button", focusable (tabindex="0"), with an
//       aria-label naming the test playground.
//   H2  keyboard path: focusing a card and pressing Enter opens the test
//       playground dialog naming that agent (the exact handler added).
//   H3  Space opens it too; Escape closes (Radix dialog default).
//   H4  focus ring classes present on the card.
// Seeds a throwaway agent via localStorage (zustand persist key
// "praison-agents", v1) when the roster is empty; removes it at the end.
// Uses the r139 harness (full pointer-event dispatch — Radix-safe).
// Usage: node scripts/cdp-qa-agents-a11y.mjs [baseUrl]

import fs from "node:fs";
import path from "node:path";

const BASE = process.argv[2] ?? "http://localhost:3000";
const OUT_DIR = path.resolve("ops/qa");
fs.mkdirSync(OUT_DIR, { recursive: true });
const QA_AGENT = {
  id: "agent_qa-r140-focus",
  name: "QA Focus Agent",
  emoji: "🎯",
  color: "cyan",
  role: "keyboard a11y probe",
  description: "Throwaway agent for the r140 keyboard-a11y QA run.",
  instructions: "Do nothing. This agent exists only for QA.",
  model: "auto",
  temperature: 0.7,
  maxIterations: 3,
  tools: [],
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
}

// ── CDP harness (r139 pattern: Radix-safe event dispatch) ───────────────────
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
    }, 25_000);
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

const cardExpr = `
  [...document.querySelectorAll('[role="button"]')].find(
    (el) => (el.getAttribute("aria-label") || "").includes("test playground")
  )`;

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
  await waitFor(ws, `document.readyState === 'complete'`);
  await new Promise((r) => setTimeout(r, 2500));

  // Seed the throwaway agent (persist write + reload) if the roster is empty.
  const rosterEmpty = await evalJs(
    ws,
    `JSON.parse(localStorage.getItem("praison-agents") ?? '{"state":{"agents":[]}}').state.agents.length === 0`
  );
  if (rosterEmpty) {
    await evalJs(
      ws,
      `localStorage.setItem("praison-agents", JSON.stringify({ state: { agents: [${JSON.stringify(QA_AGENT)}] }, version: 1 }))`
    );
    await evalJs(ws, `location.reload()`);
    await waitFor(ws, `document.readyState === 'complete'`);
    await new Promise((r) => setTimeout(r, 2500));
  }

  if (!(await retryClick(ws, "Agents"))) throw new Error("nav to Agents failed");
  await waitFor(ws, `Boolean(${cardExpr})`, 15_000);
  await new Promise((r) => setTimeout(r, 600));

  // H1 — card is a focusable, labelled button
  const h1 = await evalJs(ws, `
    (() => {
      const el = ${cardExpr};
      if (!el) return null;
      return {
        role: el.getAttribute("role"),
        tabindex: el.getAttribute("tabindex"),
        label: el.getAttribute("aria-label") ?? "",
        cls: el.className ?? "",
      };
    })()`);
  check(
    "H1 card is a labelled focusable button",
    h1?.role === "button" && h1?.tabindex === "0" && h1.label.includes("test playground"),
    `role=${h1?.role} tabindex=${h1?.tabindex} label=${(h1?.label ?? "").slice(0, 50)}`
  );

  // H2 — keyboard: focus + Enter opens the test playground dialog
  const h2 = await evalJs(ws, `
    (async () => {
      const el = ${cardExpr};
      if (!el) return { focused: false, dialog: false, dialogText: "" };
      el.focus();
      const focused = document.activeElement === el;
      el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 900));
      const dlg = document.querySelector('[role="dialog"]');
      return { focused, dialog: Boolean(dlg), dialogText: (dlg?.textContent ?? "").slice(0, 120) };
    })()`);
  const cardName = (h1?.label ?? "").replace("Open test playground for ", "");
  check(
    "H2 Enter on focused card opens test playground",
    h2?.focused === true && h2?.dialog === true && h2.dialogText.includes(cardName),
    `focused=${h2?.focused} dialog=${h2?.dialog} for="${cardName}" text=${(h2?.dialogText ?? "").slice(0, 60)}`
  );
  await shot(ws, "H-focus-ring-dialog");

  // H3 — Escape closes; Space reopens (second keyboard path)
  await evalJs(ws, `
    (() => {
      const el = document.activeElement ?? document.body;
      el.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      return true;
    })()`);
  await new Promise((r) => setTimeout(r, 700));
  const closedAfterEsc = await evalJs(ws, `!document.querySelector('[role="dialog"]')`);

  const h3 = await evalJs(ws, `
    (async () => {
      const el = ${cardExpr};
      if (!el) return { dialog: false };
      el.focus();
      el.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 900));
      return { dialog: Boolean(document.querySelector('[role="dialog"]')) };
    })()`);
  check(
    "H3 Escape closes; Space reopens playground",
    closedAfterEsc && h3?.dialog === true,
    `escClosed=${closedAfterEsc} spaceOpened=${h3?.dialog}`
  );

  // H4 — focus ring classes exist on the card
  check(
    "H4 focus-visible ring on card",
    (h1?.cls ?? "").includes("focus-visible:ring-2"),
    (h1?.cls ?? "").split(" ").filter((c) => c.startsWith("focus-visible")).join(" ")
  );

  // Cleanup — remove the throwaway agent (direct persist rewrite + reload)
  await evalJs(ws, `
    (() => {
      const raw = JSON.parse(localStorage.getItem("praison-agents") ?? '{"state":{"agents":[]}}');
      raw.state.agents = raw.state.agents.filter((a) => a.id !== ${JSON.stringify(QA_AGENT.id)});
      localStorage.setItem("praison-agents", JSON.stringify(raw));
      location.reload();
      return true;
    })()`);
  await waitFor(ws, `document.readyState === 'complete'`);

  const fails = results.filter((r) => !r.ok);
  console.log(`\n${results.length - fails.length}/${results.length} checks PASS`);
  process.exit(fails.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("QA crashed:", e.message);
  process.exit(1);
});
