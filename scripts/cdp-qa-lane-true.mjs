import { ensureChrome } from "./cdp-ensure-chrome.mjs";
// ─── CDP QA — E-series (r137): lane-true countdowns in ServerAutopilot ───────
// Live evidence (2026-09-30, pasted app state) showed two defects this fixes:
//   1. "bridge sync -5s ago" — negative relative time from server/client
//      clock skew (fmtAgo now clamps: <10s ⇒ "just now").
//   2. "next due" on pipelines that had run MINUTES ago — the DB registry's
//      nextRunAt only advances when the EXTERNAL scheduler claims a run, so
//      while the tab drives (BYOK) it goes stale-past. The panel now renders
//      the tab's own schedule.nextRunAt while browser-driving (lane-true),
//      falling back to the registry once the server lane drives.
// E-series asserts lane-truth with a decisive seed: a workflow whose LOCAL
// schedule.nextRunAt is +6h (never fires — safe) while its DB registry row
// (created by the bridge's mount sync, interval 2m) says +2m. A buggy build
// (registry-only) renders "2m"/"due"; the fixed build renders ~"6.0h".
// Cleanup: the seed IS registered in the DB by the bridge (unavoidable while
// enabled), so at the end we POST sync with enabled:false — the registry's
// designed "disabled, kept for history" path — and rewrite the localStorage
// seed disabled too. No residue that the headless lane could ever claim.
// Launch first (same shell as scripts/cdp-qa.mjs).
// Usage: node scripts/cdp-qa-lane-true.mjs [baseUrl]
import fs from "node:fs";
import path from "node:path";

const BASE = process.argv[2] ?? "http://localhost:3000";
const OUT_DIR = path.resolve("ops/qa");
fs.mkdirSync(OUT_DIR, { recursive: true });
const WF_ID = "qa-wf-e-lane";
const WF_NAME = "QA Lane-True Pipeline";
const SIX_H = 6 * 3_600_000;

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

async function retryClick(ws, label, tries = 6, gapMs = 800) {
  for (let i = 0; i < tries; i++) {
    if (await evalJs(ws, clickByText(label))) return true;
    await new Promise((r) => setTimeout(r, gapMs));
  }
  return false;
}

const seedWf = (enabled, nextRunAt) => ({
  id: WF_ID,
  name: WF_NAME,
  description: "Throwaway QA workflow — safe to delete",
  createdAt: Date.now() - 60_000,
  updatedAt: Date.now() - 60_000,
  steps: [{ id: "s1", label: "Probe", type: "agent", status: "idle" }],
  runs: [],
  schedule: {
    enabled,
    intervalMs: 120_000,
    task: "QA E-series schedule — never fires (nextRunAt +6h)",
    nextRunAt,
  },
});

const setSeed = (wf) => `
  localStorage.setItem("praison-workflows", JSON.stringify({ state: { workflows: [${JSON.stringify(wf)}] }, version: 0 }))`;

async function main() {
  await ensureChrome();
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
  await new Promise((r) => setTimeout(r, 2000));

  // Seed: LOCAL nextRunAt = +6h (safe — never fires); the bridge's mount sync
  // will register a DB row with interval 2m (nextRunAt = now+2m → "2m"/"due").
  await evalJs(ws, setSeed(seedWf(true, Date.now() + SIX_H)));
  await wsSend(ws, "Page.navigate", { url: BASE });
  await waitFor(ws, `document.readyState === 'complete'`);
  await new Promise((r) => setTimeout(r, 2500));
  if (!(await retryClick(ws, "Workflows"))) throw new Error("nav to Workflows failed");

  // Wait for the panel + the seeded row (bridge registers it on mount)
  await waitFor(ws, `document.querySelector('[aria-label="Server autopilot"]')`, 20_000);
  await waitFor(
    ws,
    `document.querySelector('[aria-label="Server autopilot"]').innerText.includes(${JSON.stringify(WF_NAME)})`,
    45_000
  );

  // E1 — chip is lane-true: ~6h from the LOCAL schedule, not "2m"/"due" (DB)
  const chipText = await evalJs(ws, `
    (() => {
      const sec = document.querySelector('[aria-label="Server autopilot"]');
      const spans = [...sec.querySelectorAll("span")];
      const chip = spans.find((e) => (e.textContent || "").includes("next fire"));
      return chip?.textContent?.trim() ?? "";
    })()
  `);
  check(
    "E1 next-fire chip shows LOCAL lane truth (~6h, not due/2m)",
    /[56]\.\dh/.test(chipText) && !chipText.includes("due") && !chipText.includes("2m"),
    chipText
  );

  // E2 — registry row is lane-true too
  const rowText = await evalJs(ws, `
    (() => {
      const sec = document.querySelector('[aria-label="Server autopilot"]');
      const li = [...sec.querySelectorAll("li")].find((e) => (e.textContent || "").includes(${JSON.stringify(WF_NAME)}));
      return li?.textContent?.replace(/\\s+/g, " ").trim() ?? "";
    })()
  `);
  check(
    "E2 registry row shows LOCAL next (~6h, not 2m/due)",
    /next [56]\.\dh/.test(rowText) && !/next (2m|due)/.test(rowText),
    rowText
  );

  // E3/E4 — no negative times; sane "bridge sync" label (3 samples across polls)
  let noNeg = true;
  let syncOk = true;
  let sample = "";
  for (let i = 0; i < 3; i++) {
    sample = await evalJs(ws, `
      document.querySelector('[aria-label="Server autopilot"]').innerText.replace(/\\n/g, " ")
    `);
    if (/(-\d+(\.\d+)?(s|m|h) ago)|next fire due|next -\d/.test(sample ?? "")) noNeg = false;
    if (!/bridge sync (just now|\d+s ago|\d+m ago|\d+\.\dh ago)/.test(sample ?? "")) syncOk = false;
    if (i < 2) await new Promise((r) => setTimeout(r, 12_000));
  }
  check("E3 no negative/stale-due times in the panel (3 poll samples)", noNeg);
  check("E4 bridge-sync label format sane across polls", syncOk, (sample ?? "").slice(0, 80));
  await shot(ws, "E-lane-true");

  // Cleanup 1: disable the DB registry row via the API's own update path
  const disRes = await fetch(`${BASE}/api/automation/sync`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      workflows: [
        {
          id: WF_ID,
          name: WF_NAME,
          task: "QA E-series schedule — disabled after test",
          intervalMs: 120_000,
          enabled: false,
          steps: [],
        },
      ],
    }),
  });
  check("E5a DB registry row disabled via sync API", disRes.ok);
  const reg = await (await fetch(`${BASE}/api/automation/sync`, { cache: "no-store" })).json();
  const row = (reg?.registry ?? []).find((r) => r.id === WF_ID);
  check("E5b registry row enabled=false (never claimable)", row?.enabled === false);

  // Cleanup 2: rewrite the localStorage seed disabled too
  await evalJs(ws, setSeed(seedWf(false, Date.now() + SIX_H)));
  await wsSend(ws, "Page.close").catch(() => {});

  const fails = results.filter((r) => !r.ok);
  console.log(`\n${results.length - fails.length}/${results.length} checks PASS`);
  process.exit(fails.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("QA crashed:", e.message);
  process.exit(1);
});
