// ─── CDP click-through QA (r129) ─────────────────────────────────────────────
// Drives the locally-installed playwright headless shell over raw CDP (node's
// native WebSocket) — bypasses the agent-browser CLI whose Chrome is
// network-isolated (ERR_NAME_NOT_RESOLVED even for 127.0.0.1).
// Launch first:
//   setsid ~/.cache/ms-playwright/chromium_headless_shell-1200/chrome-headless-shell-linux64/chrome-headless-shell \
//     --headless --no-sandbox --disable-gpu --remote-allow-origins='*' \
//     --remote-debugging-port=9222 --window-size=1440,1000 about:blank &
// Usage: node scripts/cdp-qa.mjs [baseUrl]
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

const clickByText = (label) => `
  (() => {
    const el = [...document.querySelectorAll('a,button,[role="button"],[role="menuitem"]')]
      .find((e) => (e.textContent || "").trim().toLowerCase().startsWith(${JSON.stringify(label.toLowerCase())}) && e.offsetParent !== null);
    if (!el) return false;
    el.click();
    return true;
  })()`;

async function main() {
  // New tab (about:blank), then navigate over CDP — /json/new?url= is
  // ignored by some Chrome builds (observed on HeadlessChrome/143).
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
  await evalJs(ws, "document.title"); // warm the session

  // A1 — app boots
  await waitFor(ws, `document.readyState === 'complete'`);
  await new Promise((r) => setTimeout(r, 2500)); // SPA hydration
  const brand = await evalJs(ws, `document.body.innerText.slice(0, 400)`);
  check("A1 app boots and renders", /praison/i.test(brand ?? ""), brand?.slice(0, 60).replace(/\n/g, " "));

  // A2 — Workflows view: cards (with r125 provider chips) or honest empty state
  await evalJs(ws, clickByText("Workflows"));
  const cardReady = await waitFor(
    ws,
    `document.querySelector('[data-wf-card]') || /No workflows yet/.test(document.body.innerText)`
  );
  const cardCount = await evalJs(ws, `document.querySelectorAll('[data-wf-card]').length`);
  if (cardCount > 0) {
    const chipInfo = await evalJs(ws, `
      (() => {
        const card = document.querySelector('[data-wf-card]');
        const text = card ? card.innerText : "";
        return {
          hasProviderChip: /(Built-in|No key|Vyce AI|AIHubMix|OpenRouter|Pollinations)/.test(text),
          sample: (text.match(/Built-in|No key[^\\n]*|Vyce AI[^\\n]*/g) || []).slice(0, 2),
        };
      })()
    `);
    check("A2 workflows cards render", true, `${cardCount} card(s)`);
    check("A2b provider-health chip present", chipInfo.hasProviderChip, (chipInfo.sample || []).join(" | "));
  } else {
    check("A2 workflows view renders (fresh profile, empty state)", cardReady, "No workflows yet");
  }
  await shot(ws, "A2-workflows");

  // A3 — Settings → Vault section (r124 card)
  await evalJs(ws, clickByText("Settings"));
  await new Promise((r) => setTimeout(r, 1200));
  await evalJs(ws, clickByText("Vault"));
  const vaultReady = await waitFor(ws, `Boolean(document.querySelector('#vault'))`, 10_000);
  const vaultCard = vaultReady
    ? await evalJs(ws, `
        (() => {
          const sec = document.querySelector('#vault');
          const text = sec ? sec.innerText : "";
          return {
            heading: /automation vault/i.test(text),
            hasInput: Boolean(sec.querySelector('input[type="password"]')),
            hasStore: /store|update/i.test(text),
            maskedOnly: !/sk-[A-Za-z0-9]{12,}/.test(document.body.innerText),
          };
        })()
      `)
    : null;
  check("A3 settings #vault section renders", Boolean(vaultReady));
  check(
    "A3b vault card complete (heading + input + store + masked-only)",
    Boolean(vaultCard?.heading && vaultCard?.hasInput && vaultCard?.hasStore && vaultCard?.maskedOnly),
    vaultCard ? `heading=${vaultCard.heading} input=${vaultCard.hasInput} store=${vaultCard.hasStore} masked=${vaultCard.maskedOnly}` : "n/a"
  );
  await shot(ws, "A3-vault");

  await wsSend(ws, "Page.close");
  ws.close();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("QA driver error:", e.message);
  process.exit(2);
});
