// ─── CDP QA — J-series (r224): the find-in-chat counter tells the truth ──────
// The r224 change: ChatSearch's buildHits CAPPED the hit list at 50 but the
// readout displayed hits.length — a conversation with 80 matches read
// "50 matches". Same truth-class as r223's badge bug. Now the list stays
// capped (MAX_RENDERED) while the counter reports the REAL total, and a
// "· showing first 50" suffix appears whenever the two diverge.
// Asserts end-to-end against the live dev server:
//   J1  seeded conversation (55 "zephyr" msgs + 2 "quokka" msgs) renders
//   J2  THE FIX: searching "zephyr" reads "55 matches · showing first 50"
//       and the list renders exactly 50 rows (pre-fix: "50 matches" — a lie)
//   J3  narrower query "quokka" → "2 matches", 2 rows, no "showing" suffix
//   J4  Enter jumps to the first hit (msg-flash lands on a real message)
//   J5  hygiene: original praison-conversations localStorage restored —
//       zero qa-r224 rows remain
// Seeding doctrine: the conversations store hydrates from localStorage — the
// harness snapshots the existing value, merges its throwaway conversation in,
// reloads (hydration picks it up), and restores the snapshot in J5.
// r223 lessons: boot chrome + run in ONE shell command; never assume the chat
// view is showing (ui store persists the last view — click the Chat nav item
// if needed). Launch chrome-headless-shell on :9222 first.
// Usage: node scripts/cdp-qa-search-match-truth.mjs [baseUrl]
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

const CONV_TITLE = "qa-r224 haystack";
const NAV_TO_CHAT = `(() => {
  const el = [...document.querySelectorAll("button,a")].find(
    (e) => /^(Chat|New Chat)/.test((e.textContent || "").trim()) && e.offsetParent !== null);
  if (!el) return false;
  el.click();
  return true;
})()`;

async function gotoChat(ws) {
  await wsSend(ws, "Page.navigate", { url: BASE });
  await evalJs(ws, "document.title");
  await waitFor(ws, `document.readyState === 'complete'`);
  await new Promise((r) => setTimeout(r, 2000));
  // The ui store persists the last view — land on chat explicitly.
  if (!(await evalJs(ws, `Boolean(document.querySelector('textarea[aria-label^="Message"]')?.offsetParent)`))) {
    await evalJs(ws, NAV_TO_CHAT);
    await waitFor(ws, `Boolean(document.querySelector('textarea[aria-label^="Message"]')?.offsetParent)`, 45_000);
  }
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

    // First load: snapshot the existing conversations seed.
    await gotoChat(ws);
    const snapshot = await evalJs(ws, `localStorage.getItem("praison-conversations")`);

    // Merge the throwaway conversation into the persisted state, then reload.
    await evalJs(ws, `(() => {
      const now = Date.now();
      const mk = (i, content) => ({
        id: "qa-r224-m" + i,
        role: i % 2 === 0 ? "user" : "assistant",
        content,
        createdAt: now - i * 60_000,
        toolCalls: [],
        status: "done",
      });
      const messages = [];
      for (let i = 0; i < 55; i++) messages.push(mk(i, "zephyr needle " + i + " — padding prose for the snippet window"));
      messages.push(mk(100, "quokka sighting number one near the river bend"));
      messages.push(mk(101, "a second quokka sighting by the camp"));
      let seed = null;
      try { seed = JSON.parse(localStorage.getItem("praison-conversations") || "null"); } catch {}
      const conversations = (seed?.state?.conversations ?? []).filter(
        (c) => !(c.title || "").includes("qa-r224"));
      conversations.push({
        id: "qa-r224-conv",
        title: ${JSON.stringify(CONV_TITLE)},
        messages,
        createdAt: now,
        updatedAt: now,
      });
      const next = { state: { conversations, activeId: seed?.state?.activeId ?? null }, version: seed?.version ?? 0 };
      localStorage.setItem("praison-conversations", JSON.stringify(next));
      return true;
    })()`);
    await gotoChat(ws);

    // J1 — the seeded conversation renders and can be activated
    const rowClicked = await evalJs(ws, `(() => {
      const row = [...document.querySelectorAll("aside span.truncate.text-sm.font-medium")]
        .find((s) => s.textContent.trim() === ${JSON.stringify(CONV_TITLE)});
      if (!row) return false;
      row.closest("div.group").querySelector("button").click();
      return true;
    })()`);
    const bubbles = rowClicked
      ? await waitFor(ws, `document.querySelectorAll('[data-msg-id^="qa-r224-m"]').length >= 57`, 20_000)
      : false;
    check("J1 seeded conversation renders all 57 messages", bubbles, `rowClicked=${rowClicked}`);
    if (!bubbles) {
      await shot(ws, "J1-failed-seed-state");
      throw new Error("seeded conversation did not render");
    }

    // J2 — THE FIX: 55 real matches, capped list, honest readout
    await evalJs(ws, `document.querySelector('button[aria-label="Find in conversation"]:not([disabled])')?.click()`);
    const panelOpen = await waitFor(ws, `Boolean(document.querySelector('input[aria-label="Find in conversation"]'))`, 10_000);
    check("J2a find panel opens", panelOpen);
    if (!panelOpen) throw new Error("find panel did not open");
    await evalJs(ws, `(() => {
      const input = document.querySelector('input[aria-label="Find in conversation"]');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(input, "zephyr");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`);
    await waitFor(ws, `document.querySelectorAll('[role="option"]').length === 50`, 15_000);
    const readout = await evalJs(ws, `[...document.querySelectorAll('span')].find((s) => /\\d+ matches/.test(s.textContent || ""))?.textContent ?? ""`);
    const rowsJ2 = await evalJs(ws, `document.querySelectorAll('[role="option"]').length`);
    check(
      "J2b counter reports the REAL total (55) not the cap",
      String(readout).includes("55 matches") && String(readout).includes("showing first 50"),
      `readout="${readout}"`,
    );
    check("J2c list renders exactly the capped 50 rows", rowsJ2 === 50, `rows=${rowsJ2}`);
    await shot(ws, "J2-counter-truth");

    // J3 — narrow query: no cap divergence, no "showing" suffix
    await evalJs(ws, `(() => {
      const input = document.querySelector('input[aria-label="Find in conversation"]');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(input, "quokka");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`);
    await waitFor(ws, `document.querySelectorAll('[role="option"]').length === 2`, 10_000);
    const readoutJ3 = await evalJs(ws, `[...document.querySelectorAll('span')].find((s) => /\\d+ matches/.test(s.textContent || ""))?.textContent ?? ""`);
    check(
      "J3 narrow query reads '2 matches' with no showing-suffix",
      String(readoutJ3).includes("2 matches") && !String(readoutJ3).includes("showing"),
      `readout="${readoutJ3}"`,
    );

    // J4 — Enter jumps to the first hit (flash class lands)
    await evalJs(ws, `(() => {
      const input = document.querySelector('input[aria-label="Find in conversation"]');
      input.focus();
      return true;
    })()`);
    await evalJs(ws, `(() => {
      const input = document.querySelector('input[aria-label="Find in conversation"]');
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      return true;
    })()`);
    const flashed = await waitFor(ws, `Boolean(document.querySelector('.msg-flash'))`, 5_000);
    check("J4 Enter jumps to the first hit (message flashes)", flashed);

    // J5 — hygiene: restore the original seed and prove zero residue
    await evalJs(ws, snapshot === null
      ? `localStorage.removeItem("praison-conversations"); true`
      : `localStorage.setItem("praison-conversations", ${JSON.stringify(snapshot)}); true`);
    await gotoChat(ws);
    const residue = await evalJs(ws, `document.querySelectorAll("aside span.truncate.text-sm.font-medium").length`);
    const mine = await evalJs(ws, `[...document.querySelectorAll("aside span.truncate.text-sm.font-medium")]
      .filter((s) => s.textContent.includes("qa-r224")).length`);
    check("J5 seed restored — zero qa-r224 rows remain", mine === 0, `rows=${residue} mine=${mine}`);
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
