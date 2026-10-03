// ─── CDP QA — N-series (r228): run-panel follow-once + recovery-card gate ────
// The r228 changes to workflow-run-panel.tsx:
//  (1) The recovery card rendered only for error|stopped runs, but the runner
//      emits "partial" (user-ended, progress preserved) and "blocked" (parked
//      by congestion/network, auto-resumes) — both sat in the panel with NO
//      recovery affordance even though RunRecoveryCard ships dedicated copy
//      for both. Gate is now the RECOVERY_STATUSES set (4 statuses).
//  (2) The auto-follow effect re-fired on every viewingRunId change: while a
//      scheduler-started run streamed, clicking ANY history row snapped the
//      view straight back — history was uninspectable until the run ended.
//      Now each running run is followed exactly once per panel-open (ref).
// Follow-path honesty note: a persisted "running" run is ALWAYS reconciled to
// partial/stopped at hydration (r25 zombie reconcile in stores.ts) — seeding
// status "running" via localStorage can never exercise the follow. So the
// follow checks use a REAL scheduled fire: the seed arms schedule.nextRunAt
// ~8s out, the in-tab scheduler (10s tick) fires it, the runner starts the
// run with status "running" — the exact "run started elsewhere" scenario.
// Asserts end-to-end against the live dev server:
//   N0  run panel opens from the seeded card
//   N1a scheduled fire → panel FOLLOWS the new running run (detail switches)
//   N1b manual history click WINS — detail switches to the clicked run
//   N1c no re-follow: detail stays on the clicked run across ≥1 scheduler
//       tick / streaming patches (pre-fix: yanked back to the streaming run)
//   N2  blocked run → "Run parked — auto-resume scheduled" card + Resume
//   N3  partial run → "Run stopped — resume anytime" card (pre-fix: none)
//   N4  error run → "Run failed — pick a recovery option" (regression guard)
//   N5  hygiene: praison-workflows snapshot restored — zero qa-r228 residue
// Seeding doctrine (J/M-series): merge the throwaway workflow into the
// praison-workflows persist payload, reload (hydration picks it up), restore
// the snapshot at the end. Boot chrome + run in ONE shell command; never
// assume the current view. pkill chrome first — a reused chrome wedges CDP.
// Usage: node scripts/cdp-qa-run-panel-follow-recovery.mjs [baseUrl]
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

const WF_NAME = "qa-r228 follow pipeline";
const SCHED_TASK = "qa-r228 scheduled fire";
const bodyHas = (s) => `document.body.innerText.includes(${JSON.stringify(s)})`;
const NAV_TO_WF = `(() => {
  const el = [...document.querySelectorAll("button,a")].find(
    (e) => /^Workflows/.test((e.textContent || "").trim()) && e.offsetParent !== null);
  if (!el) return false;
  el.click();
  return true;
})()`;
// The card Run button: <Button size="sm"><Play/>Run</Button> inside the card
// whose CARD SUBTREE names the workflow. Bind to the shadcn Card boundary
// (data-slot="card") — a generic parent climb reaches page-level ancestors
// that mention every workflow name (Evolution ledger) and clicks the wrong
// card (N-series first-run lesson).
const CLICK_CARD_RUN = `(() => {
  const btns = [...document.querySelectorAll("button")].filter(
    (b) => (b.textContent || "").trim() === "Run" && b.offsetParent !== null);
  const b = btns.find((x) => {
    const card = x.closest('[data-slot="card"]');
    return card && (card.textContent || "").includes(${JSON.stringify(WF_NAME)});
  });
  if (!b) return false;
  b.click();
  return true;
})()`;
const HISTORY_TOGGLE = `(() => {
  const t = document.querySelector('button[aria-label="Toggle run history"]');
  if (!t) return false; t.click(); return true;
})()`;
const rowFor = (task) =>
  `(() => {
    const el = [...document.querySelectorAll('button[aria-label^="View run from"]')].find(
      (e) => (e.getAttribute("aria-label") || "").includes(${JSON.stringify(task)}));
    if (!el) return false;
    el.click();
    return true;
  })()`;

async function main() {
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

    // ── First load: snapshot the workflows store. ────────────────────────
    await wsSend(ws, "Page.navigate", { url: BASE });
    await waitFor(ws, `document.readyState === "complete"`);
    await new Promise((r) => setTimeout(r, 1500));
    const snapshot = await evalJs(ws, `localStorage.getItem("praison-workflows")`);
    const agentSeed = await evalJs(ws, `(() => {
      try {
        const a = JSON.parse(localStorage.getItem("praison-agents") || "null");
        const first = a?.state?.agents?.[0];
        return first ? { id: first.id, name: first.name, emoji: first.emoji } : null;
      } catch { return null; }
    })()`);
    const agent = agentSeed ?? { id: "qa-agent-1", name: "Scout", emoji: "🔎" };

    // ── Seed: one workflow (schedule armed ~8s out) + runs, reload. ──────
    const now = Date.now();
    const step = (stepId, label, status, output, ms) => ({
      stepId, agentId: agent.id, agentName: agent.name, agentEmoji: agent.emoji ?? "🔎",
      label, status, output: output ?? "", toolCalls: [], ...(ms != null ? { ms } : {}),
    });
    const runs = [
      { // persisted "running" is impossible — r25 reconcile would stamp it
        // partial; seed the honest post-reconcile shape directly.
        id: "qa-r228-run-stream", task: "qa-r228 STREAM run (reconciled)",
        status: "partial", startedAt: now - 60_000, finishedAt: now - 50_000,
        steps: [step("st1", "Research", "done", "stream partial output", 1200),
                step("st2", "Synthesize", "skipped")],
      },
      { id: "qa-r228-run-history", task: "qa-r228 HISTORY row marker XYZZY",
        status: "done", startedAt: now - 3_600_000, finishedAt: now - 3_500_000,
        steps: [step("st1", "Research", "done", "qa-r228-history-step-output gold marker", 900)] },
      { id: "qa-r228-run-blocked", task: "qa-r228 PARKED run",
        status: "blocked", startedAt: now - 7_200_000, finishedAt: now - 7_100_000,
        error: { kind: "network", message: "qa-r228 gateway saturated — connection reset mid-stream",
                 hint: "The gateway is saturated. Wait for the window to pass, then resume.",
                 stepIndex: 1, stepId: "st2", stepLabel: "Research", attempts: 1,
                 stepsDone: 1, llmLabel: "browser-direct", agentName: agent.name, toolCallsOk: 0 },
        steps: [step("st1", "Research", "done", "parked partial output", 800),
                step("st2", "Synthesize", "skipped")] },
      { id: "qa-r228-run-partial", task: "qa-r228 PARTIAL run",
        status: "partial", startedAt: now - 10_800_000, finishedAt: now - 10_700_000,
        steps: [step("st1", "Research", "done", "partial run output", 700),
                step("st2", "Synthesize", "skipped")] },
      { id: "qa-r228-run-error", task: "qa-r228 FAILED run",
        status: "error", startedAt: now - 14_400_000, finishedAt: now - 14_300_000,
        error: { kind: "rate-limit", message: "qa-r228 429 quota exhausted",
                 hint: "Quota refills; the ladder cools down before retrying.",
                 stepIndex: 1, stepId: "st2", stepLabel: "Research", attempts: 1,
                 stepsDone: 1, llmLabel: "browser-direct", agentName: agent.name, toolCallsOk: 0 },
        steps: [step("st1", "Research", "done", "err output", 600),
                step("st2", "Synthesize", "error")] },
    ];
    await evalJs(ws, `(() => {
      let seed = null;
      try { seed = JSON.parse(localStorage.getItem("praison-workflows") || "null"); } catch {}
      const workflows = (seed?.state?.workflows ?? []).filter(
        (w) => !(w.name || "").includes("qa-r228"));
      workflows.push({
        id: "qa-r228-wf",
        name: ${JSON.stringify(WF_NAME)},
        description: "qa-r228 seeded pipeline",
        steps: [{ id: "s1", agentId: ${JSON.stringify(agent.id)}, label: "Research" }],
        runs: ${JSON.stringify(runs)},
        schedule: {
          enabled: true,
          intervalMs: 3_600_000,
          task: ${JSON.stringify(SCHED_TASK)},
          nextRunAt: ${now + 8_000},
        },
        createdAt: ${now - 90_000},
        updatedAt: ${now},
      });
      const next = { state: { ...(seed?.state ?? {}), workflows }, version: seed?.version ?? 0 };
      localStorage.setItem("praison-workflows", JSON.stringify(next));
      return true;
    })()`);

    // ── Reload + land on Workflows explicitly (persist remembers views). ─
    await wsSend(ws, "Page.navigate", { url: BASE });
    await waitFor(ws, `document.readyState === "complete"`);
    await new Promise((r) => setTimeout(r, 2000));
    if (!(await evalJs(ws, `Boolean([...document.querySelectorAll("button")].some(
        (b) => (b.textContent || "").trim() === "Run" && b.offsetParent !== null))`))) {
      await evalJs(ws, NAV_TO_WF);
      await waitFor(ws, `Boolean([...document.querySelectorAll("button")].some(
        (b) => (b.textContent || "").trim() === "Run" && b.offsetParent !== null))`, 45_000);
    }

    // ── N0: open the run panel from the seeded card. ─────────────────────
    const opened = await evalJs(ws, CLICK_CARD_RUN);
    check("N0 run panel opened from the seeded card", opened === true);
    // History must be OPEN before the fire so the click-wins rows exist.
    await waitFor(ws, `Boolean(document.querySelector('button[aria-label="Toggle run history"]'))`, 20_000);
    await evalJs(ws, HISTORY_TOGGLE);
    await waitFor(ws, `Boolean(document.querySelector('button[aria-label^="View run from"]'))`, 15_000);

    // ── N1a: the scheduler fires ~8-18s in → the panel FOLLOWS it. ───────
    const followed = await waitFor(ws, bodyHas(`Task: ${SCHED_TASK}`), 60_000, 500);
    check("N1a panel follows the scheduler-started run", followed,
      "detail switched to the scheduled fire without any user click");

    // ── N1b: manual history click WINS while the fire streams. ───────────
    const clicked = await evalJs(ws, rowFor("qa-r228 HISTORY row marker XYZZY"));
    await new Promise((r) => setTimeout(r, 1800));
    const won = clicked && (await evalJs(
      ws, `${bodyHas("qa-r228-history-step-output gold marker")} && !${bodyHas(`Task: ${SCHED_TASK}`)}`));
    check("N1b manual history selection WINS over auto-follow (no snap-back)", won === true,
      "pre-fix: view snapped back to the streaming run within a tick");

    // ── N1c: still on the clicked run ≥1 scheduler tick later — the ref
    //      blocks re-follow even as streaming patches churn latestRun. ────
    await new Promise((r) => setTimeout(r, 12_000));
    const stillWon = await evalJs(
      ws, `${bodyHas("qa-r228-history-step-output gold marker")} && !${bodyHas(`Task: ${SCHED_TASK}`)}`);
    check("N1c no re-follow across scheduler ticks / streaming patches", stillWon === true,
      "old effect re-fired on latestRun identity churn and yanked the view back");

    // ── N2: blocked run → parked recovery card. ──────────────────────────
    await evalJs(ws, rowFor("qa-r228 PARKED run"));
    const parked = await waitFor(ws, bodyHas("Run parked — auto-resume scheduled"), 15_000);
    const parkedResume = parked && (await evalJs(ws, bodyHas("Resume from step")));
    check("N2 blocked run shows the parked recovery card + resume", parked === true && parkedResume === true);
    await shot(ws, "N2-blocked-recovery-card");

    // ── N3: partial run → recovery card (pre-fix: NO card at all). ───────
    await evalJs(ws, rowFor("qa-r228 PARTIAL run"));
    const partial = await waitFor(ws, bodyHas("Run stopped — resume anytime"), 15_000);
    const partialCopy = partial && (await evalJs(ws, bodyHas("every completed step is kept")));
    check("N3 partial run shows the recovery card (was invisible pre-fix)", partial === true && partialCopy === true);
    await shot(ws, "N3-partial-recovery-card");

    // ── N4: error run → failed card (regression guard). ──────────────────
    await evalJs(ws, rowFor("qa-r228 FAILED run"));
    const failed = await waitFor(ws, bodyHas("Run failed — pick a recovery option"), 15_000);
    const retry = failed && (await evalJs(ws, bodyHas("Retry failed step")));
    check("N4 error run recovery card unchanged (regression guard)", failed === true && retry === true);

    // ── N5: restore the snapshot; zero residue. ──────────────────────────
    await evalJs(
      ws,
      snapshot == null
        ? `localStorage.removeItem("praison-workflows"); true`
        : `localStorage.setItem("praison-workflows", ${JSON.stringify(snapshot)}); true`);
    await wsSend(ws, "Page.navigate", { url: BASE });
    await waitFor(ws, `document.readyState === "complete"`);
    await new Promise((r) => setTimeout(r, 1500));
    const residue = await evalJs(ws, `(() => {
      const s = JSON.parse(localStorage.getItem("praison-workflows") || "null");
      return (s?.state?.workflows ?? []).filter((w) => (w.name || "").includes("qa-r228")).length;
    })()`);
    check("N5 workflows store restored — zero qa-r228 residue", residue === 0, `residue=${residue}`);
  } finally {
    try { await wsSend(ws, "Page.close"); } catch {}
  }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  console.log(`\nSUMMARY: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
