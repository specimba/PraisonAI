// ─── QA — S-series (r160): stale-cache affordance on radar tabs ─────────────
// CacheStatus now turns amber + "stale" past a per-tab TTL (HF 6h, papers 24h,
// GitHub 7d). Live check, atomic chrome:
//   S1  seed an OLD HF cache (fetchedAt = 2 days ago) → open Radar → HF tab →
//       the stamp must read "cached … · stale" with the amber class.
//   S2  seed a FRESH HF cache (fetchedAt = now) → NO stale marker, muted class.
//   S3  GitHub tab with an old cache → stale marker (per-tab TTL respected,
//       2 days < 7d TTL would be fresh — so seed 8 days old for GitHub).
// Usage: node scripts/cdp-qa-radar-stale.mjs [baseUrl]
// Chrome: setsid ~/.cache/ms-playwright/chromium_headless_shell-1200/chrome-headless-shell-linux64/chrome-headless-shell \
//   --headless --no-sandbox --disable-gpu --remote-debugging-port=9222 --window-size=1440,1000 about:blank &

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
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "eval error");
  return r.result?.value;
}
async function shot(ws, name) {
  const r = await wsSend(ws, "Page.captureScreenshot", { format: "png" });
  const file = path.join(OUT_DIR, `${name}.png`);
  fs.writeFileSync(file, Buffer.from(r.data, "base64"));
  console.log(`  📸 ${file}`);
}
const js = (s) => `(function(){ ${s} })()`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Stub HF-shaped cache with a controllable fetchedAt.
const seedCache = (ageMs) => js(`
  localStorage.setItem("praison-radar-hf", JSON.stringify({
    fetchedAt: Date.now() - ${ageMs},
    models: [{ id: "seed/model-a", downloads: 1234, likes: 12 }],
    datasets: [{ id: "seed/ds-b", downloads: 999, likes: 9 }],
    spaces: [{ id: "seed/space-c", likes: 7 }],
  }));
  return true;
`);

// Wait for the app shell (dev rehydration after reload can take seconds).
async function waitNav(ws, label, budgetMs = 12_000) {
  return evalJs(ws, js(`
    return new Promise((resolve, reject) => {
      const t0 = performance.now();
      const iv = setInterval(() => {
        const b = [...document.querySelectorAll("button")].find((x) => (x.textContent ?? "").trim().startsWith(${JSON.stringify(label)}));
        if (b) { clearInterval(iv); b.click(); return resolve("clicked"); }
        if (performance.now() - t0 > ${budgetMs}) { clearInterval(iv); return reject(new Error("nav not found: " + ${JSON.stringify(label)})); }
      }, 250);
    });
  `));
}

async function openHfTab(ws) {
  // r150 lesson: nav buttons bundle label+hint — startsWith.
  await waitNav(ws, "Radar");
  await sleep(800);
  await evalJs(ws, js(`
    // r160 HARNESS LESSON: Radix TabsTrigger activates on POINTERDOWN — a
    // synthetic .click() dispatches no pointer events and the tab silently
    // never switches (this is what made r159's R5 gate a false positive).
    // Dispatch the full pointer sequence and focus.
    const t = [...document.querySelectorAll('[role="tab"]')].find((x) => (x.textContent ?? "").includes("HF Trending"));
    if (!t) throw new Error("HF tab not found");
    t.focus();
    t.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    t.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    t.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    return true;
  `));
  await sleep(700);
  return evalJs(ws, js(`
    const el = [...document.querySelectorAll("span")].find((x) => /^cached /.test((x.textContent ?? "").trim()));
    if (!el) return { found: false };
    return {
      found: true,
      text: (el.textContent ?? "").trim(),
      amber: el.className.includes("amber"),
      muted: el.className.includes("muted-foreground") && !el.className.includes("amber"),
    };
  `));
}

async function main() {
  const tabRes = await fetch(`http://127.0.0.1:9222/json/new`, { method: "PUT" });
  const tab = await tabRes.json();
  const ws = await connect(tab.webSocketDebuggerUrl);
  await wsSend(ws, "Page.enable");
  await wsSend(ws, "Runtime.enable");
  await wsSend(ws, "Page.navigate", { url: BASE });
  await evalJs(ws, "document.title");
  await sleep(1500);

  // S1: old HF cache → stale.
  await evalJs(ws, seedCache(2 * 86_400_000));
  let s = await openHfTab(ws);
  check("S1 stale marker on 2-day-old HF cache", s.found === true && s.amber === true && /stale/.test(s.text), JSON.stringify(s));
  await shot(ws, "S-radar-stale-hf");

  // S2: fresh cache → no stale marker.
  await evalJs(ws, seedCache(0));
  await evalJs(ws, js(`location.reload(); return true;`));
  await sleep(3500); // dev rehydration is slow — waitNav below also retries
  s = await openHfTab(ws);
  check("S2 fresh cache stays muted", s.found === true && s.amber === false && !/stale/.test(s.text), JSON.stringify(s));

  // S3: GitHub tab, 8-day-old cache (past its 7d TTL) → stale.
  await evalJs(ws, js(`
    localStorage.setItem("praison-radar-gh", JSON.stringify({
      user: "seeduser",
      fetchedAt: Date.now() - ${8 * 86_400_000},
      repos: [{ id: 1, full_name: "seed/one", stargazers_count: 42, html_url: "#", pushed_at: "", description: "" }],
    }));
    return true;
  `));
  await evalJs(ws, js(`location.reload(); return true;`));
  await sleep(3500);
  await waitNav(ws, "Radar");
  await sleep(800);
  await evalJs(ws, js(`
    const t = [...document.querySelectorAll('[role="tab"]')].find((x) => (x.textContent ?? "").includes("GitHub Stars"));
    if (!t) throw new Error("GitHub tab not found");
    t.focus();
    t.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    t.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    t.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    return true;
  `));
  await sleep(700);
  s = await evalJs(ws, js(`
    const el = [...document.querySelectorAll("span")].find((x) => /^cached /.test((x.textContent ?? "").trim()));
    if (!el) return { found: false };
    return { found: true, text: (el.textContent ?? "").trim(), amber: el.className.includes("amber") };
  `));
  check("S3 GitHub 8-day cache goes stale (2-day-old would NOT)", s.found === true && s.amber === true, JSON.stringify(s));
  await shot(ws, "S-radar-stale-github");

  // Cleanup: leave no seeded profiles behind.
  await evalJs(ws, js(`
    localStorage.removeItem("praison-radar-hf");
    localStorage.removeItem("praison-radar-gh");
    return true;
  `));

  ws.close();
  const pass = results.filter((r) => r.ok).length;
  console.log(`\n${pass}/${results.length} checks passed`);
  process.exit(pass === results.length ? 0 : 1);
}

main().catch((err) => {
  console.error("QA run failed:", err.stack ?? err.message);
  process.exit(2);
});
