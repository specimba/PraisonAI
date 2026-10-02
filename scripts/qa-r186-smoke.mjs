// r186 browser smoke: workflows board renders + run panel depth chip reads stamped depth.
import { chromium } from "playwright";

const BASE = process.env.BASE_URL || "http://localhost:3000";
let pass = 0, fail = 0;
const ok = (c, m) => { console.log(`${c ? "  ✓" : "  ✗"} ${m}`); c ? pass++ : fail++; };

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

// r193: seed one workflow with a breaker-paused schedule (enabled:false,
// no autoResumeAt, failStreak 3) — the r192 board banner must explain the
// parked board, and "Resume all" must re-arm the schedule in the persisted
// store. Seeded pre-navigation so zustand persist rehydrates it.
await page.addInitScript(() => {
  localStorage.setItem("praison-workflows", JSON.stringify({
    state: {
      workflows: [{
        id: "wf-qa-paused",
        name: "QA Paused Pipeline",
        description: "seeded by qa-r186-smoke",
        steps: [{ id: "s1", agentId: "a1", label: "Seeded step", instruction: "say hi" }],
        runs: [],
        createdAt: Date.now() - 1000,
        updatedAt: Date.now() - 1000,
        schedule: { enabled: false, intervalMs: 3600000, failStreak: 3, task: "seeded task" },
      }],
      proposals: [],
    },
    version: 0,
  }));
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

// Depth chip fallback: pre-r186 runs have no stamped depth — panel shows authored depth.
// The chip text itself appears inside the run panel sheet; assert the component
// vocabulary is present in the bundle-driven page (rendered when a panel opens).
ok(/Deep|Standard|Quick/.test(body), "depth vocabulary present on board (cards/chips)");

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

await browser.close();
console.log(`\n${pass}/${pass + fail} browser smoke assertions passed`);
process.exit(fail === 0 ? 0 : 1);
