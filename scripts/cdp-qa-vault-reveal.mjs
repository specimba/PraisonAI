// ─── CDP QA — V-series (r154): vault card reveal-once ────────────────────────
// Asserts the reveal-once feature end-to-end against the live dev server:
//   V1 API: store a throwaway builtin key → ok
//   V2 UI:  Settings → #vault card shows masked preview + reveal button
//   V3 UX:  click reveal → RAW key visible in row + "visible — auto-hides" hint
//   V4 UX:  second click → immediate re-mask (mask back, hint gone)
//   V5 UX:  reveal again → wait 9s → AUTO re-mask (8s timer honored)
//   V6 UX:  reload → masked again (reveal state never persisted)
//   V7 API: delete throwaway key → vault left EMPTY (no fake-key residue)
// Reuses the C-series harness lessons: hydration retry-click loop, new-tab
// boot via PUT /json/new, atomic headless-chrome run.
// Launch first (same shell):
//   setsid ~/.cache/ms-playwright/chromium_headless_shell-1200/chrome-headless-shell-linux64/chrome-headless-shell \
//     --headless --no-sandbox --disable-gpu --remote-allow-origins='*' \
//     --remote-debugging-port=9222 --window-size=1440,1000 about:blank &
// Usage: node scripts/cdp-qa-vault-reveal.mjs [baseUrl]
import fs from "node:fs";
import path from "node:path";

const BASE = process.argv[2] ?? "http://localhost:3000";
const OUT_DIR = path.resolve("ops/qa");
fs.mkdirSync(OUT_DIR, { recursive: true });
const QA_KEY = "qa-r154-reveal-key-77d9";
const QA_MASK = "qa-r••••77d9"; // mask(): first4 + •••• + last4
const REVEAL_BTN = `document.querySelector('button[aria-label^="Reveal stored key"]')`;

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
    }, 20_000);
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
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
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

async function waitFor(ws, expr, timeoutMs = 15_000, everyMs = 400) {
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

// NOTE the parens: `a?.innerText ?? "".includes(x)` would parse as
// `a?.innerText ?? ("".includes(x))` — the r154 run's 4 FAILs were exactly
// this precedence bug (every check returned the whole innerText). 
const cardText = () => `(document.querySelector('#vault')?.innerText ?? "")`;

async function main() {
  // V0 — idempotent pre-clean
  await fetch(`${BASE}/api/vault?provider=builtin`, { method: "DELETE" });

  // V1 — store throwaway key (API lane, same as C-series)
  const storeRes = await fetch(`${BASE}/api/vault`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider: "builtin", key: QA_KEY }),
  });
  const storeJson = await storeRes.json().catch(() => ({}));
  check("V1 store throwaway vault key", storeRes.ok && storeJson.ok === true);

  // Browser boot
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

  // V2 — Settings → vault card masked + reveal button
  // (sidebar buttons bundle label+hint text → startsWith match, C/O-series lesson)
  const clickSettings = `
    (() => {
      const el = [...document.querySelectorAll("button,a")].find(
        (e) => (e.textContent || "").trim().startsWith("Settings") && e.offsetParent !== null);
      if (!el) return false;
      el.click();
      return true;
    })()`;
  let navSettings = false;
  for (let i = 0; i < 6 && !navSettings; i++) {
    navSettings = await evalJs(ws, clickSettings);
    if (!navSettings) await new Promise((r) => setTimeout(r, 800));
  }
  if (!navSettings) throw new Error("nav to Settings failed");
  if (!(await waitFor(ws, `document.querySelector('#vault')`, 15_000))) {
    throw new Error("vault card did not appear");
  }
  await waitFor(ws, `${cardText()}.includes(${JSON.stringify(QA_MASK)})`, 10_000);
  const maskedShown = await evalJs(ws, `${cardText()}.includes(${JSON.stringify(QA_MASK)})`);
  const revealBtn = await evalJs(ws, `Boolean(${REVEAL_BTN})`);
  check("V2 card shows masked preview + reveal button", maskedShown && revealBtn);

  // V3 — reveal → raw visible + hint.
  // Click-until-EFFECT (dev hydration can swallow the first click — C-series
  // lesson): effect = aria-label flips to "Hide stored key". The selector must
  // match BOTH labels since the component flips it on reveal.
  const REVEAL_ANY = `document.querySelector('button[aria-label^="Reveal stored key"], button[aria-label="Hide stored key"]')`;
  let flipped = false;
  for (let i = 0; i < 6 && !flipped; i++) {
    await evalJs(ws, `${REVEAL_ANY}?.click()`);
    await new Promise((r) => setTimeout(r, 1200));
    flipped = await evalJs(
      ws, `(${REVEAL_ANY})?.getAttribute("aria-label") === "Hide stored key"`
    );
  }
  check("V3a reveal click takes effect (aria flips)", flipped);
  await waitFor(ws, `${cardText()}.includes(${JSON.stringify(QA_KEY)})`, 5_000);
  const rawShown = await evalJs(ws, `${cardText()}.includes(${JSON.stringify(QA_KEY)})`);
  const hintShown = await evalJs(ws, `${cardText()}.includes("visible — auto-hides")`);
  const maskGone = await evalJs(ws, `!${cardText()}.includes(${JSON.stringify(QA_MASK)})`);
  check(
    "V3b reveal shows raw key + auto-hides hint",
    rawShown && hintShown && maskGone,
    `raw=${rawShown} hint=${hintShown} maskGone=${maskGone} text=${JSON.stringify((await evalJs(ws, cardText())).slice(0, 300))}`
  );
  await shot(ws, "V3-vault-revealed");

  // V4 — second click → immediate re-mask (effect: label flips back)
  await evalJs(ws, `${REVEAL_ANY}?.click()`);
  await waitFor(
    ws,
    `(${REVEAL_ANY})?.getAttribute("aria-label")?.startsWith("Reveal stored key")`,
    5_000
  );
  const remasked = await evalJs(ws, `${cardText()}.includes(${JSON.stringify(QA_MASK)})`);
  const rawGone = await evalJs(ws, `!${cardText()}.includes(${JSON.stringify(QA_KEY)})`);
  const hintGone = await evalJs(ws, `!${cardText()}.includes("visible — auto-hides")`);
  check(
    "V4 second click re-masks immediately",
    remasked && rawGone && hintGone,
    `remasked=${remasked} rawGone=${rawGone} hintGone=${hintGone}`
  );

  // V5 — reveal again → 8s auto re-mask (wait 9s)
  await evalJs(ws, `${REVEAL_ANY}?.click()`);
  await waitFor(
    ws,
    `(${REVEAL_ANY})?.getAttribute("aria-label") === "Hide stored key"`,
    8_000
  );
  await new Promise((r) => setTimeout(r, 9_000));
  const autoRemask = await evalJs(ws, `${cardText()}.includes(${JSON.stringify(QA_MASK)})`);
  const rawGone2 = await evalJs(ws, `!${cardText()}.includes(${JSON.stringify(QA_KEY)})`);
  const labelBack = await evalJs(
    ws, `(${REVEAL_ANY})?.getAttribute("aria-label")?.startsWith("Reveal stored key")`
  );
  check(
    "V5 auto re-mask after ~8s",
    autoRemask && rawGone2 && labelBack,
    `autoRemask=${autoRemask} rawGone=${rawGone2} labelBack=${labelBack}`
  );

  // V6 — reload → masked again (no reveal persistence)
  await wsSend(ws, "Page.navigate", { url: `${BASE}/?view=settings` });
  await waitFor(ws, `document.readyState === 'complete'`);
  await new Promise((r) => setTimeout(r, 2500));
  if (!(await waitFor(ws, `document.querySelector('#vault')`, 15_000))) {
    // settings may need a nav click after reload depending on view routing
    await retryClickAria(ws, "Open navigation");
    await evalJs(ws, `
      [...document.querySelectorAll("button,a")].find(
        (e) => (e.textContent || "").trim() === "Settings" && e.offsetParent !== null)?.click()`);
    await waitFor(ws, `document.querySelector('#vault')`, 15_000);
  }
  await waitFor(ws, `${cardText()}.includes(${JSON.stringify(QA_MASK)})`, 10_000);
  const reloadMasked = await evalJs(ws, `${cardText()}.includes(${JSON.stringify(QA_MASK)})`);
  const reloadRawGone = await evalJs(ws, `!${cardText()}.includes(${JSON.stringify(QA_KEY)})`);
  check(
    "V6 reload re-masks (no persistence)",
    reloadMasked && reloadRawGone,
    `masked=${reloadMasked} rawGone=${reloadRawGone}`
  );

  // V7 — cleanup: delete + assert empty
  const delRes = await fetch(`${BASE}/api/vault?provider=builtin`, { method: "DELETE" });
  const delJson = await delRes.json().catch(() => ({}));
  check("V7 delete throwaway key (vault left empty)", delRes.ok && delJson.ok === true);
  await shot(ws, "V6-vault-remasked");

  const pass = results.filter((r) => r.ok).length;
  console.log(`\nV-series: ${pass}/${results.length} ${pass === results.length ? "PASS" : "FAIL"}`);
  process.exit(pass === results.length ? 0 : 1);
}

main().catch((e) => {
  console.error("FATAL:", e.message);
  process.exit(1);
});
