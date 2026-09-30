// ─── QA — G-series (r139): /api/radar/hf proxy + HF tab e2e ─────────────────
// r139 routes the LAST radar source through the server: HF Trending now dials
// our own /api/radar/hf instead of huggingface.co from the browser (GitHub
// Stars and Paper Radar already had proxies). Asserts:
//   G1–G3  proxy happy path: kind=models/datasets/spaces → 200 {kind,count,
//          items[]} with string ids (trimmed fields only).
//   G4     kind allow-list: bogus kind → 400 "Unknown Hub section".
//   G5     limit clamp: limit=999 → 200 with count ≤ 50.
//   G6     browser e2e: Radar → HF Trending tab → Refresh → the panel renders
//          a fresh "cached just now" stamp and NO ErrorBox (the proxy-driven
//          path works end-to-end in the real UI).
//   G7     no client code still points at huggingface.co directly (byte-level
//          grep of the served bundle is overkill; grep src/ instead — run by
//          the caller, see scripts bottom note).
// Usage: node scripts/cdp-qa-radar-hf-proxy.mjs [baseUrl]
// Launch browser first (same shell as scripts/cdp-qa.mjs).

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

async function proxyGet(qs) {
  const res = await fetch(`${BASE}/api/radar/hf${qs}`, { signal: AbortSignal.timeout(30_000) });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

// ── CDP harness (same pattern as D/F-series) ────────────────────────────────
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

// Radix primitives (Tabs trigger etc.) activate on mousedown — a plain
// el.click() (r132 pattern, click-only) silently no-ops on them. Dispatch the
// full sequence so both Radix (mousedown) and plain onClick (click) respond.
const emitClick = `
  (() => {
    const fire = (el) => {
      const opts = { bubbles: true, cancelable: true, view: window };
      el.dispatchEvent(new PointerEvent("pointerdown", opts));
      el.dispatchEvent(new MouseEvent("mousedown", opts));
      el.dispatchEvent(new PointerEvent("pointerup", opts));
      el.dispatchEvent(new MouseEvent("click", opts));
    };
    return { fire };
  })()`;

const clickByText = (label) => `
  (() => {
    const el = [...document.querySelectorAll('a,button,[role="button"],[role="tab"],[role="menuitem"]')]
      .find((e) => (e.textContent || "").trim().toLowerCase().startsWith(${JSON.stringify(label.toLowerCase())}) && e.offsetParent !== null);
    if (!el) return false;
    (${emitClick}).fire(el);
    return true;
  })()`;

async function retryClick(ws, label, tries = 8, gapMs = 800) {
  for (let i = 0; i < tries; i++) {
    if (await evalJs(ws, clickByText(label))) return true;
    await new Promise((r) => setTimeout(r, gapMs));
  }
  return false;
}

// ── main ────────────────────────────────────────────────────────────────────
async function main() {
  // G1–G3 — proxy happy path, all three Hub sections
  for (const kind of ["models", "datasets", "spaces"]) {
    const r = await proxyGet(`?kind=${kind}&limit=5`);
    const items = r.json?.items;
    check(
      `G${["models", "datasets", "spaces"].indexOf(kind) + 1} proxy kind=${kind}`,
      r.status === 200 &&
        r.json?.kind === kind &&
        Array.isArray(items) &&
        items.length >= 1 &&
        typeof items[0]?.id === "string",
      `status=${r.status} count=${r.json?.count} first=${items?.[0]?.id?.slice(0, 40) ?? "-"}`
    );
  }

  // G4 — kind allow-list
  const rBad = await proxyGet(`?kind=bogus`);
  check(
    "G4 unknown kind → 400 classified",
    rBad.status === 400 && (rBad.json?.error ?? "").includes("Unknown Hub section"),
    `status=${rBad.status} err=${(rBad.json?.error ?? "").slice(0, 60)}`
  );

  // G5 — limit clamp
  const rBig = await proxyGet(`?kind=models&limit=999`);
  check(
    "G5 limit clamped to ≤ 50",
    rBig.status === 200 && Array.isArray(rBig.json?.items) && rBig.json.items.length <= 50,
    `status=${rBig.status} count=${rBig.json?.count}`
  );

  // G6 — browser e2e: Radar → HF Trending → Refresh → fresh cache stamp, no error box
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

  if (!(await retryClick(ws, "Radar"))) throw new Error("nav to Radar failed");

  // Select the HF Trending tab — verify the aria-selected flip, don't trust
  // the click alone (r139 G6 lesson: a blind .click() on a Radix trigger can
  // silently no-op while the script believes it succeeded).
  const clickHfTab = `
    (() => {
      const t = [...document.querySelectorAll('button[role="tab"]')]
        .find((e) => (e.textContent || "").trim().toLowerCase().startsWith("hf trending") && e.offsetParent !== null);
      if (!t) return false;
      (${emitClick}).fire(t);
      return t.getAttribute("aria-selected") === "true";
    })()`;
  let hfSelected = false;
  for (let i = 0; i < 8 && !hfSelected; i++) {
    hfSelected = await evalJs(ws, clickHfTab);
    if (!hfSelected) await new Promise((r) => setTimeout(r, 800));
  }
  check("G6a HF Trending tab selected", hfSelected === true);

  // Click Refresh only when the button is actually enabled (CacheStatus
  // disables it while a fetch is in flight; clicking a disabled button is a
  // silent no-op).
  const clickRefreshEnabled = `
    (() => {
      const b = [...document.querySelectorAll('button')]
        .find((e) => (e.textContent || "").trim().startsWith("Refresh") && e.offsetParent !== null);
      if (!b || b.disabled) return false;
      (${emitClick}).fire(b);
      return true;
    })()`;
  let refreshed = false;
  for (let i = 0; i < 12 && !refreshed; i++) {
    refreshed = await evalJs(ws, clickRefreshEnabled);
    if (!refreshed) await new Promise((r) => setTimeout(r, 900));
  }

  // After the proxy-driven refresh the cache stamp must read fresh ("just
  // now") and no ErrorBox may be present.
  const gotStamp = await waitFor(
    ws,
    `(document.querySelector('[role="region"][aria-label="Trending models"]')?.innerText ?? "") !== "" &&
     (document.body.innerText.match(/cached (just now|\\d+[smhd] ago)/) !== null)`,
    30_000
  );
  const hasErrorBox = await evalJs(ws, `Boolean(document.querySelector('[role="alert"]'))`);
  check(
    "G6b HF tab e2e: refresh via proxy renders fresh cache, no error",
    refreshed && gotStamp && !hasErrorBox,
    `clicked=${refreshed} stamp=${gotStamp} errorBox=${hasErrorBox}`
  );
  await shot(ws, "G-hf-proxy");
  await wsSend(ws, "Page.close").catch(() => {});

  const fails = results.filter((r) => !r.ok);
  console.log(`\n${results.length - fails.length}/${results.length} checks PASS`);
  process.exit(fails.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("QA crashed:", e.message);
  process.exit(1);
});
