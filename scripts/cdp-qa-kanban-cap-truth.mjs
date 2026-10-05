import { ensureChrome } from "./cdp-ensure-chrome.mjs";
// ─── CDP QA — M-series (r227): the runs kanban cap tells the truth ───────────
// The r227 change: groupRuns used to slice done/attention to 10 cards BEFORE
// anything counted — a pipeline with 30 completed runs read "Done 10" and its
// filter chip said 10, as if the cap were the total (same truth-class as the
// r224 search-counter bug). Now groupRuns returns the full arrays, the board
// renders 10 cards, the column badge reads "10/14", a "+N older runs not
// shown" footer names the rest, and filter chips count the real total.
// Asserts end-to-end against the live dev server:
//   M1  14 seeded done runs → Done badge reads "10/14" (cap + true total)
//   M2  Done column footer: "+4 older runs not shown"
//   M3  12 seeded error runs → Needs-you badge "10/12" + "+2 older" footer
//       (both capped lanes honest)
//   M4  filter chip for the pipeline counts ALL its cards (26), not 10
//   M5  hygiene: praison-workflows snapshot restored — zero qa-r227 residue
// Seeding doctrine (J-series): merge the throwaway workflow into the
// praison-workflows persist payload, reload (hydration picks it up), restore
// the snapshot at the end. r223/r224 lessons: boot chrome + run in ONE shell
// command; never assume the current view. Launch chrome-headless-shell on
// :9222 first.
// Usage: node scripts/cdp-qa-kanban-cap-truth.mjs [baseUrl]
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

const WF_NAME = "qa-r227 cap pipeline";
const NAV_TO_WF = `(() => {
  const el = [...document.querySelectorAll("button,a")].find(
    (e) => /^Workflows/.test((e.textContent || "").trim()) && e.offsetParent !== null);
  if (!el) return false;
  el.click();
  return true;
})()`;
const BOARD_TOGGLE = `document.querySelector('button[aria-label="Runs board layout"]')`;
const BOARD = `document.querySelector('[aria-label="Runs kanban board"]')`;
const DONE_SECTION = `document.querySelector('section[aria-label^="Done column"]')`;
const ATTN_SECTION = `document.querySelector('section[aria-label^="Needs you column"]')`;
const CHIP_GROUP = `document.querySelector('[role="group"][aria-label="Board filter by pipeline"]')`;

async function gotoWorkflows(ws) {
  await wsSend(ws, "Page.navigate", { url: BASE });
  await evalJs(ws, "document.title");
  await waitFor(ws, `document.readyState === 'complete'`);
  await new Promise((r) => setTimeout(r, 2000));
  // The ui store persists the last view — land on Workflows explicitly.
  if (!(await evalJs(ws, `Boolean(${BOARD_TOGGLE}) || Boolean(document.querySelector('input[placeholder*="task" i]'))`))) {
    await evalJs(ws, NAV_TO_WF);
    await waitFor(ws, `Boolean(${BOARD_TOGGLE}) || Boolean(document.querySelector('input[placeholder*="task" i]'))`, 45_000);
  }
}

async function main() {
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

    // First load: snapshot the workflows store.
    await gotoWorkflows(ws);
    const snapshot = await evalJs(ws, `localStorage.getItem("praison-workflows")`);

    // Merge the throwaway workflow (14 done + 12 error runs) into the
    // persisted state, then reload.
    await evalJs(ws, `(() => {
      const now = Date.now();
      const mkRun = (i, status) => ({
        id: "qa-r227-run-" + i,
        task: "cap truth run " + i + " — padding prose so the card has a body",
        status,
        startedAt: now - (i + 1) * 90_000,
        finishedAt: now - (i + 1) * 90_000 + 60_000,
        steps: [],
      });
      const runs = [];
      for (let i = 0; i < 14; i++) runs.push(mkRun(i, "done"));
      for (let i = 100; i < 112; i++) runs.push(mkRun(i, "error"));
      let seed = null;
      try { seed = JSON.parse(localStorage.getItem("praison-workflows") || "null"); } catch {}
      const workflows = (seed?.state?.workflows ?? []).filter(
        (w) => !(w.name || "").includes("qa-r227"));
      workflows.push({
        id: "qa-r227-wf",
        name: ${JSON.stringify(WF_NAME)},
        description: "kanban cap-truth fixture",
        steps: [],
        runs,
        createdAt: now,
        updatedAt: now,
      });
      const next = { state: { ...(seed?.state ?? {}), workflows }, version: seed?.version ?? 0 };
      localStorage.setItem("praison-workflows", JSON.stringify(next));
      return true;
    })()`);
    await gotoWorkflows(ws);

    // Open the board (may already be open — the ui store may persist it).
    if (!(await evalJs(ws, `Boolean(${BOARD})`))) {
      await evalJs(ws, `${BOARD_TOGGLE}?.click()`);
      await waitFor(ws, `Boolean(${BOARD})`, 20_000);
    }
    if (!(await evalJs(ws, `Boolean(${BOARD})`))) throw new Error("kanban board did not open");

    // M1 — Done badge reads "10/14"
    const doneBadge = await evalJs(ws,
      `[...(${DONE_SECTION}?.querySelectorAll("header span") ?? [])]
        .map((s) => s.textContent.trim()).find((t) => /^10\\/.\\d+$/.test(t)) ?? ""`);
    // r227 harness lesson: the live server lane may contribute REAL done runs
    // mid-test — assert the INVARIANT (badge = 10/total, rendered = cap),
    // never absolute counts.
    const doneTotal = Number((doneBadge.split("/")[1] ?? "0"));
    check("M1 Done badge shows cap/total (10/≥14)",
      /^10\/\d+$/.test(doneBadge) && doneTotal >= 14, `badge="${doneBadge}"`);

    // M2 — Done footer names the hidden 4
    const doneFooter = await evalJs(ws,
      `[...(${DONE_SECTION}?.querySelectorAll("p") ?? [])]
        .map((p) => p.textContent.trim()).find((t) => t.includes("older")) ?? ""`);
    const doneHidden = Number((doneFooter.match(/\+(\d+) older/) ?? [])[1] ?? -1);
    check("M2 Done footer = total − 10 hidden runs",
      doneHidden === doneTotal - 10 && doneFooter.includes("older runs not shown"),
      `footer="${doneFooter}" total=${doneTotal}`);

    // M3 — Needs-you lane honest too (12 error runs, capped at 10)
    const attnBadge = await evalJs(ws,
      `[...(${ATTN_SECTION}?.querySelectorAll("header span") ?? [])]
        .map((s) => s.textContent.trim()).find((t) => /^10\\/.\\d+$/.test(t)) ?? ""`);
    const attnFooter = await evalJs(ws,
      `[...(${ATTN_SECTION}?.querySelectorAll("p") ?? [])]
        .map((p) => p.textContent.trim()).find((t) => t.includes("older")) ?? ""`);
    const attnTotal = Number((attnBadge.split("/")[1] ?? "0"));
    const attnHidden = Number((attnFooter.match(/\+(\d+) older/) ?? [])[1] ?? -1);
    check("M3 Needs-you badge 10/≥12 + footer = total − 10",
      /^10\/\d+$/.test(attnBadge) && attnTotal >= 12 && attnHidden === attnTotal - 10,
      `badge="${attnBadge}" footer="${attnFooter}"`);
    await shot(ws, "M2-cap-truth");

    // M4 — filter chip counts ALL 26 cards of the pipeline (pre-fix: 10)
    const chipText = await evalJs(ws,
      `[...(${CHIP_GROUP}?.querySelectorAll("button") ?? [])]
        .map((b) => b.textContent.trim()).find((t) => t.includes(${JSON.stringify(WF_NAME)})) ?? ""`);
    // our 26 + any real server-lane cards; pre-fix it read the capped 10.
    // Floor is 26 (our seeded cards are guaranteed); column totals include
    // other workflows' server cards, so no stronger per-workflow bound exists.
    const chipN = Number((chipText.match(/(\d+)$/) ?? [])[1] ?? -1);
    check("M4 filter chip counts the real total (≥26)", chipN >= 26, `chip="${chipText}"`);

    // M5 — hygiene: restore the store, prove zero residue
    // r260: restore write happens from a bare same-origin JSON page (gotoBare)
    // — a live app page's in-memory persist can race a foreign write and
    // resurrect qa-r* rows before gotoWorkflows re-hydrates (J5 race, r259).
    const gotoBare = async (ws) => {
      await evalJs(ws, `window.__r260bare = 1`);
      await evalJs(ws, `location.href = "/api/providers/free-models"`);
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 100));
        try {
          if (String(await evalJs(ws, `window.__r260bare`)) !== "1") {
            if ((await evalJs(ws, `document.readyState`)) === "complete") return true;
          }
        } catch { /* execution context detached mid-navigation */ }
      }
      return false;
    };
    await gotoBare(ws);
    await evalJs(ws, snapshot === null
      ? `localStorage.removeItem("praison-workflows"); true`
      : `localStorage.setItem("praison-workflows", ${JSON.stringify(snapshot)}); true`);
    await gotoWorkflows(ws);
    const residue = await evalJs(ws, `(() => {
      try {
        const s = JSON.parse(localStorage.getItem("praison-workflows") || "null");
        return (s?.state?.workflows ?? []).filter((w) => (w.name || "").includes("qa-r227")).length;
      } catch { return -1; }
    })()`);
    check("M5 workflows store restored — zero qa-r227 residue", residue === 0, `residue=${residue}`);
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
