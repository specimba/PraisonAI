// ─── CDP QA — I-series (r223): the chat-list badge tells the truth ────────────
// The r223 change: the "Chats" header badge always showed sorted.length (the
// TOTAL), even while a search filter reduced the list to a few matches — the
// badge contradicted the list it labels. Now it shows filtered.length while
// searching (with a "N of M chats match" title) and the total otherwise.
// Asserts end-to-end against the live dev server:
//   I1  sidebar renders; badge and rendered row count agree
//   I2  two uniquely-named chats created via New chat + kebab-Rename
//   I3  searching for one name → badge reads 1 AND exactly 1 row renders
//   I4  clearing the search → badge returns to the full count
//   I5  hygiene: both throwaway chats deleted via kebab → Delete dialog →
//       badge and row count back to the I1 baseline, no qa-r223 rows remain
// Radix lessons (r221): DropdownMenuTrigger opens on the full pointer sequence
// (pointerdown + mousedown + click at the element's center); dialogs close by
// CLICKING their buttons — Escape dispatch is unreliable.
// r222 lesson: the sandbox reaps background chrome between tool calls — boot
// chrome AND run this suite in the SAME shell command (boot-wait loop → node).
// Launch: pkill -f chrome-headless-shell; setsid
//   ~/.cache/ms-playwright/chromium_headless_shell-1200/chrome-headless-shell-linux64/chrome-headless-shell \
//   --remote-debugging-port=9222 --window-size=1440,1000 about:blank &
// Usage: node scripts/cdp-qa-chat-list-truth.mjs [baseUrl]
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
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }
    }, 60_000);
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

async function waitFor(ws, expr, timeoutMs = 30_000, everyMs = 400) {
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

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
}

// ─── Page-side selectors (aside is the chat-list surface) ────────────────────
const ASIDE = `document.querySelector('aside[aria-label="Conversations"]')`;
const BADGE = `document.querySelector('aside[aria-label="Conversations"] h2 + span')`;
const BADGE_NUM = `parseInt(${BADGE}?.textContent ?? "-1", 10)`;
const ROWS = `[...(${ASIDE})?.querySelectorAll("span.truncate.text-sm.font-medium") ?? []]`;
const ROW_COUNT = `${ROWS}.length`;
const TITLE_SPANS = (name) =>
  `${ROWS}.filter((s) => s.textContent.trim() === ${JSON.stringify(name)}).length`;

/** Open a row's kebab menu with the full Radix pointer sequence, click a named item. */
async function kebabAction(ws, rowTitle, action) {
  const titleJson = JSON.stringify(rowTitle);
  const actionJson = JSON.stringify(action);
  for (let i = 0; i < 3; i++) {
    await evalJs(ws, `(() => {
      const row = [...(${ROWS})].find((s) => s.textContent.trim() === ${titleJson});
      if (!row) return false;
      const container = row.closest("div.group");
      const kebab = [...(container?.querySelectorAll("button") ?? [])].find(
        (b) => (b.getAttribute("aria-label") || "").startsWith("Options for"));
      if (!kebab) return false;
      const rect = kebab.getBoundingClientRect();
      const opts = { bubbles: true, cancelable: true, view: window, button: 0,
                     clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2 };
      kebab.dispatchEvent(new PointerEvent("pointerdown", opts));
      kebab.dispatchEvent(new MouseEvent("mousedown", opts));
      kebab.dispatchEvent(new MouseEvent("click", opts));
      return true;
    })()`);
    await waitFor(ws, `Boolean(document.querySelector('[role="menuitem"]'))`, 5_000);
    const clicked = await evalJs(ws, `(() => {
      const item = [...document.querySelectorAll('[role="menuitem"]')].find(
        (m) => (m.textContent || "").trim().startsWith(${actionJson}));
      if (!item) return false;
      item.click();
      return true;
    })()`);
    if (!clicked) continue;
    // Rename opens a dialog; Delete opens an alertdialog.
    const dlg = await waitFor(
      ws,
      `Boolean(document.querySelector('[role="dialog"] input, [role="alertdialog"]'))`,
      5_000,
    );
    if (dlg) return true;
  }
  return false;
}

/** Create a chat and rename it to a unique title (kebab → Rename → dialog). */
async function createNamedChat(ws, title) {
  const created = await evalJs(ws, `(() => {
    const btn = document.querySelector('button[aria-label="New chat"]');
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  if (!created) return false;
  await new Promise((r) => setTimeout(r, 600));
  const opened = await kebabAction(ws, "New chat", "Rename");
  if (!opened) return false;
  // Type the new title into the rename dialog's input.
  await evalJs(ws, `(() => {
    const input = document.querySelector('[role="dialog"] input[aria-label="Chat title"]');
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(input, ${JSON.stringify(title)});
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`);
  await evalJs(ws, `(() => {
    const btn = [...document.querySelectorAll('[role="dialog"] button')].find(
      (b) => (b.textContent || "").trim() === "Save");
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  return waitFor(ws, `${TITLE_SPANS(title)} === 1`, 10_000);
}

async function main() {
  // Browser boot
  const tabRes = await fetch(`http://127.0.0.1:9222/json/new`, { method: "PUT" });
  if (!tabRes.ok) throw new Error(`/json/new failed: ${tabRes.status} — is chrome-headless-shell up?`);
  const tab = await tabRes.json();
  const ws = await connect(tab.webSocketDebuggerUrl);
  try {
    await wsSend(ws, "Page.enable");
    await wsSend(ws, "Runtime.enable");
    await wsSend(ws, "Emulation.setDeviceMetricsOverride", {
      width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false,
    });
    await wsSend(ws, "Page.navigate", { url: BASE });
    await evalJs(ws, "document.title");
    await waitFor(ws, `document.readyState === 'complete'`);
    await new Promise((r) => setTimeout(r, 2500));

    // I1 — sidebar renders; badge and rows agree at baseline
    const asideOk = await waitFor(ws, `Boolean(${ASIDE})`, 45_000);
    check("I1 conversations sidebar renders", asideOk);
    if (!asideOk) throw new Error("sidebar did not render in 45s");
    // Zero-state: the badge is rendered in the header regardless; create one chat
    // if the list is empty so the search UI exists at all.
    if ((await evalJs(ws, ROW_COUNT)) === 0) {
      await evalJs(ws, `document.querySelector('button[aria-label="New chat"]')?.click()`);
      await waitFor(ws, `${ROW_COUNT} >= 1`, 15_000);
    }
    const baseBadge = await evalJs(ws, BADGE_NUM);
    const baseRows = await evalJs(ws, ROW_COUNT);
    check("I1b baseline badge equals rendered row count", baseBadge === baseRows, `badge=${baseBadge} rows=${baseRows}`);

    // I2 — create two uniquely-named chats
    const mkA = await createNamedChat(ws, "qa-r223 badge-target");
    const mkB = mkA ? await createNamedChat(ws, "qa-r223 decoy") : false;
    check("I2 two chats created and renamed", mkA && mkB);
    if (!mkA || !mkB) {
      await shot(ws, "I2-failed-create-state");
      throw new Error("could not create/rename the throwaway chats");
    }
    const afterBadge = await evalJs(ws, BADGE_NUM);
    const afterRows = await evalJs(ws, ROW_COUNT);
    check("I2b badge tracks the new total", afterBadge === baseBadge + 2 && afterRows === baseRows + 2, `badge=${afterBadge} rows=${afterRows}`);
    await shot(ws, "I2-two-chats");

    // I3 — THE FIX: search filters the list AND the badge follows the matches
    await evalJs(ws, `(() => {
      const input = document.querySelector('input[aria-label="Search conversations"]');
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(input, "badge-target");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`);
    await waitFor(ws, `${ROW_COUNT} === ${baseRows + 1}`, 10_000);
    const searchBadge = await evalJs(ws, BADGE_NUM);
    const searchRows = await evalJs(ws, ROW_COUNT);
    check(
      "I3 badge shows the MATCH count while searching (not the total)",
      searchBadge === 1 && searchRows === 1,
      `badge=${searchBadge} rows=${searchRows}`,
    );
    await shot(ws, "I3-search-badge-truth");

    // I4 — clearing the search restores the total
    await evalJs(ws, `(() => {
      const clear = document.querySelector('button[aria-label="Clear search"]');
      if (!clear) return false;
      clear.click();
      return true;
    })()`);
    await waitFor(ws, `${ROW_COUNT} === ${baseRows + 2}`, 10_000);
    const clearedBadge = await evalJs(ws, BADGE_NUM);
    check("I4 clearing the search restores the total badge", clearedBadge === baseBadge + 2, `badge=${clearedBadge}`);

    // I5 — hygiene: delete both throwaway chats (destructive path on throwaways only)
    for (const title of ["qa-r223 badge-target", "qa-r223 decoy"]) {
      const opened = await kebabAction(ws, title, "Delete");
      if (!opened) throw new Error(`delete dialog did not open for ${title}`);
      await evalJs(ws, `(() => {
        const btn = [...document.querySelectorAll('[role="alertdialog"] button')].find(
          (b) => (b.textContent || "").trim() === "Delete");
        if (!btn) return false;
        btn.click();
        return true;
      })()`);
      await waitFor(ws, `${TITLE_SPANS(title)} === 0`, 10_000);
    }
    const endBadge = await evalJs(ws, BADGE_NUM);
    const endRows = await evalJs(ws, ROW_COUNT);
    const residue = await evalJs(ws, `${ROWS}.filter((s) => s.textContent.includes("qa-r223")).length`);
    check(
      "I5 throwaway chats deleted — badge and rows back to baseline, zero residue",
      endBadge === baseBadge && endRows === baseRows && residue === 0,
      `badge=${endBadge} rows=${endRows} residue=${residue}`,
    );
  } finally {
    try { ws.close(); } catch {}
    try { await fetch(`http://127.0.0.1:9222/json/close/${tab.id}`); } catch {}
  }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  console.log(`\nSUMMARY: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`FATAL: ${err.message}`);
  process.exit(1);
});
