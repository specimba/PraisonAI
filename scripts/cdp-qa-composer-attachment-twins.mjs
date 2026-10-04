import { ensureChrome } from "./cdp-ensure-chrome.mjs";
// ─── CDP QA — H-series (r222): duplicate-named attachments remove one, not all ─
// The r222 fix: Composer.removeAttachment filtered by NAME
// (prev.filter(a => a.name !== name)) — but duplicate-named attachments are
// legal (paste the same screenshot twice, attach a same-named file from two
// folders; addFiles does not dedupe), so clicking × on ONE chip silently
// removed every twin. Now it removes by index.
// Asserts end-to-end against the live dev server:
//   H1  chat composer renders (message textarea visible)
//   H2  POSITIVE CONTROL: two same-name .txt files planted through the hidden
//       file input (DataTransfer + input.files) → exactly 2 chips render
//   H3  click × on the SECOND twin → exactly 1 chip remains (pre-fix this
//       read 0 — both twins died together)
//   H4  click × on the survivor → 0 chips (the normal path still removes)
// Hygiene: attachments are component state only — nothing persisted, no API
// writes, nothing to clean up after the run.
// r221 infra lessons applied: pkill any stray chrome-headless-shell BEFORE
// boot (a wedged one made the /json/new fetch hang forever) and hard-timeout
// every external command.
// Launch: pkill -f chrome-headless-shell; setsid
//   ~/.cache/ms-playwright/chromium_headless_shell-1200/chrome-headless-shell-linux64/chrome-headless-shell \
//   --remote-debugging-port=9222 --window-size=1440,1000 about:blank &
// Usage: node scripts/cdp-qa-composer-attachment-twins.mjs [baseUrl]
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

// Chip counting + twin planting all run inside the page.
const CHIP_COUNT = `document.querySelectorAll('[role="list"][aria-label^="Attached files"] [role="listitem"]').length`;

async function main() {
  // Browser boot
  await ensureChrome();
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

    // H1 — composer renders. Chat is the default view, but the ui store
    // PERSISTS the last view (r223 lesson: a prior QA run that ended on the
    // agents view leaves every later tab there) — so click the Chat nav item
    // explicitly when the composer isn't already on screen.
    let taOk = await waitFor(
      ws,
      `Boolean(document.querySelector('textarea[aria-label^="Message"]')?.offsetParent)`,
      15_000,
    );
    if (!taOk) {
      await evalJs(ws, `(() => {
        const el = [...document.querySelectorAll("button,a")].find(
          (e) => /^(Chat|New Chat)/.test((e.textContent || "").trim()) && e.offsetParent !== null);
        if (!el) return false;
        el.click();
        return true;
      })()`);
      taOk = await waitFor(
        ws,
        `Boolean(document.querySelector('textarea[aria-label^="Message"]')?.offsetParent)`,
        45_000,
      );
    }
    check("H1 composer textarea renders", taOk);
    if (!taOk) throw new Error("composer did not render in 45s");

    // H2 — POSITIVE: plant two SAME-NAME text files through the hidden input.
    // DataTransfer → input.files → synthetic change is the one reliable way to
    // feed real File objects without the CDP file-upload domain.
    await evalJs(ws, `(() => {
      const dt = new DataTransfer();
      const mk = (body) => new File([body], "twin-draft.txt", { type: "text/plain" });
      dt.items.add(mk("first twin"));
      dt.items.add(mk("second twin"));
      const input = document.querySelector('input[type="file"][aria-label="Attach files or images"]');
      if (!input) throw new Error("hidden file input not found");
      input.files = dt.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    })()`);
    const twoChips = await waitFor(ws, `${CHIP_COUNT} === 2`, 20_000);
    const chipCountH2 = await evalJs(ws, CHIP_COUNT);
    check("H2 two same-name chips render (positive control)", twoChips && chipCountH2 === 2, `chips=${chipCountH2}`);
    if (!twoChips) {
      await shot(ws, "H2-failed-chip-state");
      throw new Error("twins did not render — cannot run the removal assertions");
    }
    await shot(ws, "H2-twin-chips");

    // H3 — THE FIX: click × on the SECOND twin → exactly 1 chip survives.
    // (Pre-fix both shared aria-label and one click removed both → 0 chips.)
    await evalJs(ws, `(() => {
      const btns = [...document.querySelectorAll(
        'button[aria-label="Remove attachment twin-draft.txt"]')];
      if (btns.length !== 2) return false;
      btns[1].click();
      return true;
    })()`);
    await waitFor(ws, `${CHIP_COUNT} === 1`, 10_000);
    const chipCountH3 = await evalJs(ws, CHIP_COUNT);
    check("H3 removing one twin leaves exactly one chip", chipCountH3 === 1, `chips=${chipCountH3}`);
    await shot(ws, "H3-one-twin-survives");

    // H4 — the survivor still removes normally.
    await evalJs(ws, `(() => {
      const btn = document.querySelector('button[aria-label="Remove attachment twin-draft.txt"]');
      if (!btn) return false;
      btn.click();
      return true;
    })()`);
    await waitFor(ws, `${CHIP_COUNT} === 0`, 10_000);
    const chipCountH4 = await evalJs(ws, CHIP_COUNT);
    check("H4 survivor removes normally (list back to zero)", chipCountH4 === 0, `chips=${chipCountH4}`);
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
