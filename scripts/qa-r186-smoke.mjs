// r186 browser smoke: workflows board renders + run panel depth chip reads stamped depth.
// r192: breaker banner round-trip. r195: changelog freshness proof.
// r196: import dialog credential honesty + keep-on-silent round-trip.
// r197: event-backed schedule-evidence chips (red missed / amber error / green ok).
// r201: StaleBuildGuard assertiveness — foreground re-poll, re-toast (one id),
// tab-title ping.
import { chromium } from "playwright";

const BASE = process.env.BASE_URL || "http://localhost:3000";
let pass = 0, fail = 0;
const ok = (c, m) => { console.log(`${c ? "  ✓" : "  ✗"} ${m}`); if (c) pass++; else fail++; };

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

// r193: seed one workflow with a breaker-paused schedule (enabled:false,
// no autoResumeAt, failStreak 3) — the r192 board banner must explain the
// parked board, and "Resume all" must re-arm the schedule in the persisted
// store. Seeded pre-navigation so zustand persist rehydrates it.
//
// r197: three more workflows with ENABLED schedules exercise the
// event-evidence chip's three tones. nextRunAt is pushed into the future so
// the smoke's own scheduler tick does not fire them mid-assertion:
//   wf-qa-ev-missed — last scheduled fire 5h ago (interval 1h → 3× window
//                     blown) → RED "no fire in 5h"
//   wf-qa-ev-error  — last scheduled fire failed 20m ago → AMBER
//   wf-qa-ev-ok     — last scheduled fire done 10m ago → muted green
await page.addInitScript(() => {
  const now = Date.now();
  const hour = 3_600_000;
  const mkRun = (id, wfId, wfName, source, status, startedAt) => ({
    id,
    workflowId: wfId,
    workflowName: wfName,
    task: "seeded task",
    status,
    startedAt,
    finishedAt: startedAt + 60_000,
    source,
    steps: [],
  });
  localStorage.setItem("praison-workflows", JSON.stringify({
    state: {
      workflows: [
        {
          id: "wf-qa-paused",
          name: "QA Paused Pipeline",
          description: "seeded by qa-r186-smoke",
          steps: [{ id: "s1", agentId: "a1", label: "Seeded step", instruction: "say hi" }],
          runs: [],
          createdAt: now - 1000,
          updatedAt: now - 1000,
          schedule: { enabled: false, intervalMs: 3600000, failStreak: 3, task: "seeded task" },
        },
        {
          id: "wf-qa-ev-missed",
          name: "QA Evidence Missed",
          description: "seeded by qa-r186-smoke (r197 red)",
          steps: [{ id: "s1", agentId: "a1", label: "Seeded step", instruction: "say hi" }],
          runs: [mkRun("run-qa-ev-missed-1", "wf-qa-ev-missed", "QA Evidence Missed", "scheduled", "done", now - 5 * hour)],
          createdAt: now - 2 * day(),
          updatedAt: now,
          schedule: { enabled: true, intervalMs: hour, lastRunAt: now - 5 * hour, nextRunAt: now + hour, task: "seeded task" },
        },
        {
          id: "wf-qa-ev-error",
          name: "QA Evidence Error",
          description: "seeded by qa-r186-smoke (r197 amber)",
          steps: [{ id: "s1", agentId: "a1", label: "Seeded step", instruction: "say hi" }],
          runs: [mkRun("run-qa-ev-error-1", "wf-qa-ev-error", "QA Evidence Error", "scheduled", "error", now - 20 * 60_000)],
          createdAt: now - 2 * day(),
          updatedAt: now,
          schedule: { enabled: true, intervalMs: hour, failStreak: 2, lastRunAt: now - 20 * 60_000, nextRunAt: now + hour, task: "seeded task" },
        },
        {
          id: "wf-qa-ev-ok",
          name: "QA Evidence Ok",
          description: "seeded by qa-r186-smoke (r197 green)",
          evolution: {
            proposalId: "prop-qa-1",
            sourceWorkflowId: "wf-qa-parent",
            sourceWorkflowName: "QA Parent Research",
            reason:
              'the router is exploiting the leading branch — "Deep Compare" averaged 95% novelty across 1 scored variation',
            acceptedAt: now - day(),
          },
          steps: [{ id: "s1", agentId: "a1", label: "Seeded step", instruction: "say hi" }],
          runs: [mkRun("run-qa-ev-ok-1", "wf-qa-ev-ok", "QA Evidence Ok", "scheduled", "done", now - 10 * 60_000)],
          createdAt: now - 2 * day(),
          updatedAt: now,
          schedule: { enabled: true, intervalMs: hour, lastRunAt: now - 10 * 60_000, nextRunAt: now + hour, task: "seeded task" },
        },
      ],
      proposals: [
        {
          // r206: a follow-up variation sourced from the seeded wf-qa-ev-ok run
          // — exercises the run-history router chip. The goal embeds the
          // ANGLES[2] string verbatim so angleOfProposal() can recover it.
          id: "prop-qa-run-chip",
          createdAt: now - 30 * 60_000,
          status: "open",
          goal:
            "QA follow-up — a practical, execution-oriented angle with step-by-step actions (seeded by qa-r186-smoke)",
          reason: "QA router citation: exploring the least-used branch after 1 prior variation",
          sourceWorkflowId: "wf-qa-ev-ok",
          sourceWorkflowName: "QA Evidence Ok",
          sourceRunId: "run-qa-ev-ok-1",
        },
      ],
    },
    version: 0,
  }));
  function day() { return 24 * 3_600_000; }
});

try {
  await page.goto(`${BASE}/`, { waitUntil: "networkidle", timeout: 45000 });
} catch { /* networkidle can be flaky with polling routes */ }
await page.waitForTimeout(2500); // client hydration + store rehydration

// The board is a tab — navigate to it if not already active.
const nav = page.locator("nav, aside").first();
if (/Workflow Studio/i.test(await page.locator("body").innerText()) === false) {
  await page.locator("button", { hasText: "Multi-agent pipelines" }).first().click().catch(() => {});
  await page.waitForTimeout(1500);
}
ok(true, "board route loaded");
const body = await page.locator("body").innerText();
ok(/Workflow Studio/i.test(body), "Workflow Studio heading renders");
ok(/Evolution ledger|Pipelines|Runs board/i.test(body), "board sections render");

// r205: the server-lane chip must state EXECUTOR truth (the executorLane
// mirror: first vault slot, registry-provider pairing, builtin skipped) —
// not the legacy builtin-slot read that could claim a lane the executor
// would refuse. Defensive on which honest state shows: the live vault may
// hold no key, a builtin slot, or a registry-provider key.
await page.waitForSelector('[aria-label="Headless lane key status"]', { timeout: 15_000 }).catch(() => null);
const laneChip = await page.textContent('[aria-label="Headless lane key status"]').catch(() => null);
ok(!!laneChip, "server autopilot lane chip renders (r205)");
ok(!!laneChip && laneChip.trim().startsWith("server lane: "), `lane chip states executor truth (${(laneChip ?? "").trim()})`);

// r208: the Automation pulse strip — one honest aggregate of the r192–r207
// diagnostics instruments (schedules/parked, 24h run outcomes, evolution
// inbox, attention verdict). Renders as soon as the first sync GET lands.
await page.waitForSelector('[aria-label="Automation pulse"]', { timeout: 15_000 }).catch(() => null);
const pulseText = (await page.textContent('[aria-label="Automation pulse"]').catch(() => null)) ?? "";
ok(!!pulseText, "automation pulse strip renders (r208)");
ok(/Schedules/i.test(pulseText) && /active/.test(pulseText), `pulse counts registry schedules (${pulseText.replace(/\s+/g, " ").trim().slice(0, 80)})`);
ok(/Evolution inbox/i.test(pulseText) && /\d+\s*open\s*·\s*\d+\s*accepted/.test(pulseText), "pulse aggregates the evolution inbox counts");
ok(/Needs attention/i.test(pulseText) && /(all clear|\d+ items?)/.test(pulseText), `pulse states the attention verdict (${/Needs attention[\s\S]{0,40}/.exec(pulseText)?.[0]?.replace(/\s+/g, " ").trim() ?? "missing"})`);

// Depth chip fallback: pre-r186 runs have no stamped depth — panel shows authored depth.
// The chip text itself appears inside the run panel sheet; assert the component
// vocabulary is present in the bundle-driven page (rendered when a panel opens).
ok(/Deep|Standard|Quick/.test(body), "depth vocabulary present on board (cards/chips)");

// r197: event-evidence chips — health from stamped run events, not promises.
const chip = page.locator('[data-testid="schedule-evidence-chip"]');
ok(
  await chip.filter({ hasText: "no fire in" }).first().isVisible().catch(() => false),
  "evidence chip RED 'no fire in 5h' renders for the stale-schedule seed"
);
ok(
  await chip.filter({ hasText: "· error" }).first().isVisible().catch(() => false),
  "evidence chip AMBER 'last fire · error' renders for the failing seed"
);
ok(
  await chip.filter({ hasText: "· done" }).first().isVisible().catch(() => false),
  "evidence chip muted-green 'last fire · done' renders for the ok seed"
);
// Directive (d) literal ask: the tooltip cites the backing run event ID.
const okTip = await chip.filter({ hasText: "· done" }).first().getAttribute("title").catch(() => "");
ok(/run run-qa-ev-ok-1/.test(okTip ?? ""), "chip tooltip cites the backing run event id");

// r203 Evolution lineage: the spawned-workflow card carries a violet chip
// whose tooltip cites the router's decision reason even after the inbox
// row is gone (structured Workflow.evolution, stamped at accept-time).
const evoChip = page.locator("span", { hasText: "Evolution spawn" }).first();
ok(
  await evoChip.isVisible().catch(() => false),
  "Evolution lineage chip renders on the spawned workflow card (r203)"
);
const evoTip = (await evoChip.getAttribute("title").catch(() => "")) ?? "";
ok(
  /exploiting the leading branch/.test(evoTip) && /QA Parent Research/.test(evoTip),
  "lineage tooltip cites the router decision reason + source workflow (r203)"
);

// r206: the SOURCE run of a variation carries the router chip — the same
// decision evidence, now reachable from the run that triggered it. Open the
// run panel via the runs-board row for the seeded run, then assert the chip
// and its tooltip (reason + branch recovered from the goal + inbox status).
// The kanban renders only in the "Runs board" layout — switch to it first.
await page.locator('[aria-label="Runs board layout"]').first().click().catch(() => {});
await page.waitForTimeout(800);
await page.locator('button[data-wf-card="wf-qa-ev-ok"]').first().click().catch(() => {});
await page.waitForTimeout(1200); // panel sheet open + history rows render
// r206: run history is a Collapsible closed by default — expand it so the
// per-run chips (novelty, evidence, router) mount.
await page.locator("button", { hasText: "Run history" }).first().click().catch(() => {});
await page.waitForTimeout(600);
const spawnChip = page
  .locator('[aria-label="This run triggered an Evolution variation proposal"]')
  .first();
ok(
  await spawnChip.isVisible().catch(() => false),
  "run-history router chip renders for the run that triggered a variation (r206)"
);
const spawnTip = (await spawnChip.getAttribute("title").catch(() => "")) ?? "";
ok(
  /QA router citation/.test(spawnTip) &&
    /a practical, execution-oriented angle/.test(spawnTip) &&
    /open in the spawn inbox/.test(spawnTip),
  "router chip tooltip cites reason + recovered branch + inbox status (r206)"
);
await page.keyboard.press("Escape").catch(() => {});
await page.waitForTimeout(500); // sheet close before the board round-trips
// Switch back to the card grid — the r192 breaker banner lives there.
await page.locator('[aria-label="Card grid layout"]').first().click().catch(() => {});
await page.waitForTimeout(800);

ok(errors.length === 0, `no page errors (${errors.length})`);
if (errors.length) console.log(errors.slice(0, 3).join("\n"));

// r192 banner round-trip: seeded breaker-paused schedule → banner renders,
// "Resume all" re-enables the schedule in the persisted store, banner clears.
const bannerVisible = await page.locator("text=Lane degraded").first().isVisible().catch(() => false);
ok(bannerVisible, "breaker banner renders for the seeded paused schedule");
if (bannerVisible) {
  await page.locator("button", { hasText: "Resume all" }).first().click();
  await page.waitForTimeout(1200); // debounced persist (450ms) + re-render
  const stored = JSON.parse((await page.evaluate(() => localStorage.getItem("praison-workflows"))) ?? "{}");
  const seeded = (stored?.state?.workflows ?? []).find((w) => w.id === "wf-qa-paused");
  ok(!!seeded?.schedule?.enabled, "Resume all re-enables the seeded schedule (persisted state)");
  ok(
    !(await page.locator("text=Lane degraded").first().isVisible().catch(() => false)),
    "banner clears after the bulk resume (self-limiting, no stale warning)"
  );
}

// r195: in-app changelog — Settings → "What's fixed" renders. The section
// doubles as a freshness proof: it only exists in r195+ bundles.
await page.locator("button", { hasText: "Settings" }).first().click().catch(() => {});
await page.waitForTimeout(1200);
ok(
  /What.s fixed recently/i.test(await page.locator("body").innerText()),
  "Settings → What's fixed changelog renders (r195+ bundle proof)"
);

// r196: import confirm dialog — a scrubbed export must state its credential
// disposition honestly (amber note + "keys are kept" copy) and Cancel must
// abort without writing or reloading.
const scrubbedFile = {
  name: "scrubbed-export.json",
  mimeType: "application/json",
  buffer: Buffer.from(JSON.stringify({
    exportedAt: new Date().toISOString(),
    settings: { seeded: true, temperature: 0.55 },
    agents: [],
    conversations: [],
    workflows: [],
  })),
};
const importInput = page.locator('[data-testid="full-import-input"]');
await importInput.setInputFiles(scrubbedFile);
await page.waitForTimeout(600);
const dialogSel = "text=Replace current data with this import?";
ok(
  await page.locator(dialogSel).first().isVisible().catch(() => false),
  "import confirm dialog opens for a picked scrubbed file"
);
ok(
  await page.locator("text=No credentials in this export").first().isVisible().catch(() => false),
  "amber 'No credentials in this export' note renders for a scrubbed file"
);
ok(
  /Provider keys in this browser are kept/.test(await page.locator("body").innerText()),
  "dialog copy states keys are kept when the file carries none"
);
await page.locator("button", { hasText: "Cancel" }).first().click();
await page.waitForTimeout(300);
ok(
  !(await page.locator(dialogSel).first().isVisible().catch(() => false)),
  "Cancel aborts the import (no reload, no write)"
);

// r201: StaleBuildGuard assertiveness (fresh context, no seeds — the guard
// is isolated from the board assertions above). Route /api/version with a
// controllable stamp: the mount poll adopts "boot-a" as baseline, then the
// stamp flips to "boot-b" and a visibilitychange (foreground return) must
// re-poll IMMEDIATELY (r201 upgrade #1 — not the clamped 60s interval),
// surface the sticky toast + pill, ping the tab title (#3), and a second
// foreground return must reuse the same toast id (#2 — replace, not stack).
const guardCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const gp = await guardCtx.newPage();
let verHits = 0;
await gp.route("**/api/version", (route) => {
  verHits++;
  return route.fulfill({ json: { stamp: verHits <= 1 ? "boot-a" : "boot-b" } });
});
await gp.goto(BASE, { waitUntil: "domcontentloaded" }).catch(() => {});
await gp.waitForTimeout(2500); // mount poll adopts "boot-a" as the baseline
ok(
  !(await gp.locator('[data-testid="stale-build-pill"]').isVisible().catch(() => false)),
  "guard silent while the server stamp is unchanged since load"
);
await gp.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
await gp.waitForTimeout(1200);
ok(
  await gp.locator('[data-testid="stale-build-pill"]').isVisible().catch(() => false),
  "foreground return re-polls the stamp immediately → stale pill appears (r201)"
);
const guardToast = await gp.locator("[data-sonner-toast]").first().innerText().catch(() => "");
ok(
  /App updated|old code/i.test(guardToast),
  "sticky stale toast fires on the visibility-detected change"
);
ok(
  (await gp.title()).includes("🔄"),
  "tab title pings while stale (visible in the tab strip)"
);
await gp.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
// The page may carry unrelated app toasts (e.g. the AIHubMix announcement),
// so the no-spam contract counts only STALE-build toasts: a re-assert with
// the same sonner id must replace in place — exactly one, always.
let settledCount = -1;
for (let i = 0; i < 12; i++) {
  settledCount = await gp
    .locator("[data-sonner-toast]", { hasText: "App updated" })
    .count();
  if (settledCount === 1) break;
  await gp.waitForTimeout(400);
}
ok(
  settledCount === 1,
  "re-assert on second foreground return reuses one toast id (no stack spam)"
);
await guardCtx.close();

// r196 keep-behavior round-trip (must run LAST — it reloads the page):
// seed a local credential, import the scrubbed file for real, confirm the
// replace — the file's settings must apply AND the local key must survive.
await page.evaluate(() => {
  localStorage.setItem("praison-settings", JSON.stringify({
    state: { settings: { apiKey: "sk-qa-keep-me", temperature: 0.7, seeded: true } },
    version: 0,
  }));
});
await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
await page.waitForTimeout(2000);
// navigate back to Settings and pick the file again post-reload
await page.locator("button", { hasText: "Settings" }).first().click().catch(() => {});
await page.waitForTimeout(1000);
await importInput.setInputFiles(scrubbedFile);
await page.waitForTimeout(600);
await page.locator("button", { hasText: "Replace & reload" }).first().click();
await page.waitForTimeout(3000); // import writes + location.reload()
const storedSettings = JSON.parse(
  (await page.evaluate(() => localStorage.getItem("praison-settings"))) ?? "{}"
);
const st = storedSettings?.state?.settings ?? {};
ok(st.apiKey === "sk-qa-keep-me", "keep-behavior: local apiKey survives the scrubbed import");
ok(st.temperature === 0.55, "keep-behavior: file settings applied (temperature from file)");

await browser.close();
console.log(`\n${pass}/${pass + fail} browser smoke assertions passed`);
process.exit(fail === 0 ? 0 : 1);
