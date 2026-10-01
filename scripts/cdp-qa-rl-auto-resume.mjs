#!/usr/bin/env node
// ─── r171 QA: congestion auto-resume (H-series) — repaired r172 ─────────────
// User report: "still getting too many request errors and the job stopping
// itself" — the r156 breaker disabled rate-limited schedules FOREVER (manual
// resume only). The fix makes congestion trips self-heal. This harness proves:
//   H1  a schedule parked with autoResumeAt in the past is auto-resumed by
//       the scheduler tick (enabled flips true, flag cleared, streak kept,
//       toast announces it) — and fires NO run (0-step fixture)
//   H2  a schedule whose autoResumeAt is still in the future is NOT touched
//       (no premature resurrection)
//   H3  the red manual-pause chip (no autoResumeAt, streak ≥ 2) still renders,
//       and clicking it resumes while CLEARING the stale-flag fields — a
//       manual resume can never be later resurrected by a leftover timestamp
// r172 repair (two concurrent r171 sessions left this file internally
// inconsistent — 3-fixture checks over a 1-fixture seed — and the persisted
// reads raced the 450ms debounced flush):
//   • Seed restored to THREE fixtures: rl-backoff (elapsed flag), rl-future
//     (future flag), rl-manual (manual pause, no flag).
//   • Persisted-state assertions no longer read localStorage once, ~100ms
//     after the in-memory transition (the debounced flush has not landed yet
//     — the old reds H1b/c/e, H3c/d measured the debounce window, not the
//     product). persisted() polls the RAW localStorage JSON until the
//     predicate holds or 6s pass — asserting the real durability guarantee:
//     the transition reaches persisted state promptly. In-memory behavior is
//     separately proven by the toasts + chips.
// Usage: node scripts/cdp-qa-rl-auto-resume.mjs [baseUrl]

import { chromium } from "playwright";

const BASE = process.argv[2] ?? "http://localhost:3000";

let passed = 0;
let failed = 0;
function check(name, ok, detail = "") {
  if (ok) passed += 1;
  else failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const MIN = 60_000;
// steps defaults to [] — a 0-step fixture is the H1 design ("fires NO run").
// Call sites originally passed no 4th arg, persisting steps:undefined —
// malformed workflow data that deterministically broke boot (2×2/8 runs:
// no nav, no tick, store untouched; single-fixture probes with real steps
// booted fine every time).
function wf(id, name, schedule, steps = []) {
  return {
    id,
    name,
    description: `r171 fixture ${id}`,
    steps,
    runs: [],
    createdAt: 1,
    updatedAt: 1,
    ...(schedule ? { schedule } : {}),
  };
}

async function main() {
  const browser = await chromium.launch({
    executablePath:
      "/home/z/.cache/ms-playwright/chromium_headless_shell-1200/chrome-headless-shell-linux64/chrome-headless-shell",
    args: ["--no-sandbox"],
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 300)));

  // r171 harness note: getByText against sonner toasts proved racy/fragile
  // across runs while the toast DOM provably renders — poll textContent of
  // [data-sonner-toast] instead (same approach the debug run validated).
  async function waitForToast(substr, timeout = 25_000) {
    try {
      await page.waitForFunction(
        (s) => [...document.querySelectorAll("[data-sonner-toast]")].some((t) => (t.textContent ?? "").includes(s)),
        substr,
        { timeout }
      );
      return true;
    } catch {
      return false;
    }
  }

  // r172: poll the RAW persisted JSON until `pred` holds (or timeout). Reads
  // the debounced-storage output the way a crash-recovery reload would —
  // this is the durability guarantee under test, not the 450ms window.
  async function persisted(pred, timeout = 6_000, every = 120) {
    const t0 = Date.now();
    let snap = null;
    for (;;) {
      snap = await page.evaluate(() => {
        const raw = localStorage.getItem("praison-workflows");
        if (!raw) return null;
        try {
          return JSON.parse(raw).state.workflows.reduce(
            (acc, w) => ({ ...acc, [w.id]: w.schedule }),
            {}
          );
        } catch {
          return null;
        }
      });
      if (snap && pred(snap)) return snap;
      if (Date.now() - t0 > timeout) return snap;
      await page.waitForTimeout(every);
    }
  }

  try {
    // THREE fixtures — exactly the states the three lanes assert:
    //   rl-backoff : rate-limit backoff, autoResumeAt already elapsed → H1
    //   rl-future  : rate-limit backoff, autoResumeAt in the future → H2
    //   rl-manual  : manual pause (streak ≥ 2, NO flag) → H3 red chip lane
    const seed = {
      state: {
        workflows: [
          wf("rl-backoff", "Backoff Wf", {
            enabled: false,
            intervalMs: 60 * MIN,
            task: "t",
            failStreak: 2,
            autoResumeTrips: 1,
            autoResumeAt: Date.now() - 1000, // already elapsed
          }),
          wf("rl-future", "Future Wf", {
            enabled: false,
            intervalMs: 60 * MIN,
            task: "t",
            failStreak: 2,
            autoResumeTrips: 1,
            autoResumeAt: Date.now() + 30 * MIN, // still parked
          }),
          wf("rl-manual", "Manual Wf", {
            enabled: false,
            intervalMs: 60 * MIN,
            task: "t",
            failStreak: 3, // ≥ 2 → red chip lane, no autoResumeAt
          }),
        ],
      },
      version: 0,
    };

    // Deterministic ONE-SHOT seeding: addInitScript runs on every navigation,
    // but the seed must apply only to the FIRST load — an HMR reload mid-run
    // (concurrent dev edits) would otherwise re-seed over the flushed resumed
    // state and the state assertions would read seed values while the toasts
    // prove the resume happened. (This exact interaction is what produced the
    // misleading "11.5s stale" dbg-rl3 readings during the concurrent r171
    // edits.) The sessionStorage guard makes the seed exactly-once per tab;
    // beforeunload flushes pending debounced writes, so a reload rehydrates
    // the RESUMED state, never the seed.
    // localStorage.clear() first: the real profile must not leak in (its due
    // schedules would fire REAL LLM runs mid-QA and pollute the assertions).
    await context.addInitScript(
      (s) => {
        if (sessionStorage.getItem("__rlqa_seeded") === "1") return;
        sessionStorage.setItem("__rlqa_seeded", "1");
        localStorage.clear();
        localStorage.setItem("praison-workflows", JSON.stringify(s));
      },
      seed
    );
    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });

    // ── H1 + H2: scheduler tick (≤10s) auto-resumes only the elapsed one ──
    check("H1a toast announced the auto-resume", await waitForToast("Gateway backoff elapsed"));

    // Persisted transition must LAND (any time within 6s — the debounce is
    // free to batch; a crash-recovery reload just needs it to be there).
    const states = await persisted(
      (s) => s["rl-backoff"]?.enabled === true && s["rl-backoff"]?.autoResumeAt === undefined
    );
    const backoff = states?.["rl-backoff"];
    const future = states?.["rl-future"];

    check(
      "H1b Backoff Wf re-enabled",
      backoff?.enabled === true,
      `enabled=${backoff?.enabled}`
    );
    check(
      "H1c Backoff Wf autoResumeAt cleared (no stale flag)",
      backoff?.autoResumeAt === undefined,
      `autoResumeAt=${backoff?.autoResumeAt}`
    );
    check(
      "H1d Backoff Wf streak PRESERVED (still-saturated gate re-trips longer)",
      backoff?.failStreak === 2,
      `failStreak=${backoff?.failStreak}`
    );
    check(
      "H1e Backoff Wf re-armed with a fresh nextRunAt",
      typeof backoff?.nextRunAt === "number" && backoff.nextRunAt > Date.now() - 15_000,
      `nextRunAt=${backoff?.nextRunAt}`
    );
    check(
      "H2a Future Wf untouched (still disabled, flag intact)",
      future?.enabled === false &&
        typeof future?.autoResumeAt === "number" &&
        future.autoResumeAt > Date.now(),
      `enabled=${future?.enabled} autoResumeAt=${future?.autoResumeAt}`
    );
    check(
      "H2b auto-resume fired for Backoff Wf only (single toast)",
      (await page.evaluate(() =>
        [...document.querySelectorAll("[data-sonner-toast]")].filter((t) =>
          (t.textContent ?? "").includes("Gateway backoff elapsed")
        ).length
      )) === 1
    );

    // ── H3: manual pause chip renders, resumes, clears stale flags ────────
    await page.getByRole("button", { name: /^Workflows/ }).first().dispatchEvent("pointerdown", { button: 0 });
    await page.getByRole("button", { name: /^Workflows/ }).first().click();
    const chip = page.getByRole("button", { name: /auto-paused · click to resume/ }).first();
    await chip.waitFor({ timeout: 15_000 });
    check("H3a red manual-pause chip renders (streak ≥ 2, no flag)", true);

    // Only Manual Wf carries the red chip (Backoff/Future are flag states)
    check(
      "H3b exactly one red chip (flagged backoffs use the amber chip lane)",
      (await page.getByRole("button", { name: /auto-paused · click to resume/ }).count()) === 1
    );

    await chip.click();
    check("H3c resume toast confirmed", await waitForToast("Schedule resumed"));
    // Persisted manual-resume transition must land (same durability contract).
    const after = await persisted(
      (s) => s["rl-manual"]?.enabled === true && s["rl-manual"]?.failStreak === 0
    );
    const manual = after?.["rl-manual"];
    check(
      "H3c manual resume re-enables + resets streak",
      manual?.enabled === true && manual?.failStreak === 0,
      `enabled=${manual?.enabled} failStreak=${manual?.failStreak}`
    );
    check(
      "H3d manual resume clears autoResumeAt/autoResumeTrips (stale-flag safety)",
      manual?.autoResumeAt === undefined && manual?.autoResumeTrips === 0,
      `autoResumeAt=${manual?.autoResumeAt} trips=${manual?.autoResumeTrips}`
    );
  } catch (err) {
    failed += 1;
    console.log(`FAIL  harness error — ${err?.message ?? err}`);
  } finally {
    await browser.close();
  }

  console.log(`\nH-series: ${passed} pass, ${failed} fail`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
