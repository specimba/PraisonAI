#!/usr/bin/env node
// ─── r167 QA: relay reorder affordance (AA-series) ──────────────────────────
// The HopRow disable logic indexed the FULL displayed chain but reordered the
// FILTERED (auto-excluded) list, and pinned the second-to-last row via
// `index >= chain.length - 2` — correct only while the auto hop is present.
// With the built-in engine as primary (the DEFAULT fresh profile) the auto
// hop is absent, and the second-to-last REAL hop's "Move down" was wrongly
// disabled — the bottom pair of the fallback chain could not be swapped.
//   A1  auto primary → no "Built-in engine" row, 6 vyce arena rows
//   A2  THE BUG: second-to-last row's Move-down ENABLED (was disabled);
//       last row's down + first row's up stay pinned
//   A3  swapping persists relayOrder with the tail swapped
//   A4  DOM reflects the swap (agnes above ultra after the move)
//   A5  custom primary → auto row IS present (pinned, no arrows), last real
//       hop down disabled, second-to-last enabled — the correct-pin case
// Usage: node scripts/cdp-qa-relay-reorder.mjs [baseUrl]

import { chromium } from "playwright";

const BASE = process.argv[2] ?? "http://localhost:3000";

let passed = 0;
let failed = 0;
function check(name, ok, detail = "") {
  if (ok) passed += 1;
  else failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const VYCE_KEY = "vyce_test_key";

async function seedAndOpen(page, settingsPatch) {
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" }).catch(() => {});
  await page.evaluate(([patch]) => {
    localStorage.setItem(
      "praison-settings",
      JSON.stringify({ state: { settings: patch }, version: 0 })
    );
  }, [settingsPatch]);
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  const nav = page.getByRole("button", { name: /^Settings/ }).first();
  await nav.waitFor({ timeout: 20000 });
  await nav.dispatchEvent("pointerdown", { button: 0 });
  await nav.dispatchEvent("pointerup", { button: 0 });
  await nav.click();
  await page.getByTestId("model-relay-card").waitFor({ timeout: 20000 });
  return page.getByTestId("model-relay-card");
}

async function main() {
  const browser = await chromium.launch({
    executablePath:
      "/home/z/.cache/ms-playwright/chromium_headless_shell-1200/chrome-headless-shell-linux64/chrome-headless-shell",
    args: ["--no-sandbox"],
  });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    // ── Scenario A: auto primary (default) — auto hop ABSENT from the chain
    const card = await seedAndOpen(page, {
      provider: "auto",
      providerKeys: { vyce: { key: VYCE_KEY } },
    });
    const rows = card.locator('[role="listitem"]');
    check("A1a six vyce arena rows", (await rows.count()) === 6, `count=${await rows.count()}`);
    check("A1b no 'Built-in engine' row on auto primary", !(await card.getByText("Built-in engine").isVisible().catch(() => false)));

    const downOf = (model) => card.getByRole("button", { name: `Move Vyce AI · ${model} down` });
    const upOf = (model) => card.getByRole("button", { name: `Move Vyce AI · ${model} up` });
    const enabled = (btn) => btn.isEnabled().catch(() => false);

    // THE BUG — second-to-last real hop (deepseek-v4-flash, row 5 of 6)
    check("A2a second-to-last hop CAN move down (was wrongly pinned)", await enabled(downOf("deepseek-v4-flash")));
    check("A2b last hop's down stays pinned", !(await enabled(downOf("agnes-3.0-flash"))));
    check("A2c first hop's up stays pinned", !(await enabled(upOf("deepseek-v4.1"))));

    // A3: swap the tail pair → relayOrder persists
    await downOf("deepseek-v4-flash").click();
    await page.waitForTimeout(500);
    const stored = await page.evaluate(() => {
      const raw = localStorage.getItem("praison-settings");
      return raw ? JSON.parse(raw)?.state?.settings?.relayOrder : undefined;
    });
    check(
      "A3 relayOrder persisted with the tail swapped",
      Array.isArray(stored) &&
        stored[4] === "vyce::agnes-3.0-flash" &&
        stored[5] === "vyce::deepseek-v4-flash" &&
        stored[0] === "vyce::deepseek-v4.1",
      JSON.stringify(stored)
    );

    // A4: DOM reflects the swap — agnes row now before ultra row
    const agnesBox = await card.getByText("agnes-3.0-flash").first().boundingBox();
    const ultraBox = await card.getByText("deepseek-v4-flash", { exact: true }).first().boundingBox();
    check("A4 swap visible in DOM order", !!agnesBox && !!ultraBox && agnesBox.y < ultraBox.y);

    // ── Scenario B: custom primary — auto hop PRESENT (pinned last)
    const cardB = await seedAndOpen(page, {
      provider: "custom",
      activeProviderId: "vyce",
      providerKeys: { vyce: { key: VYCE_KEY, model: "deepseek-v4.1" } },
      relayOrder: [],
    });
    check("B1 'Built-in engine' row present on custom primary", await cardB.getByText("Built-in engine").isVisible());
    const autoRow = cardB.locator('[role="listitem"]', { hasText: "Built-in engine" }).first();
    check("B2 auto row renders no reorder arrows", (await autoRow.getByRole("button").count()) === 0);
    const downB = (model) => cardB.getByRole("button", { name: `Move Vyce AI · ${model} down` });
    check("B3 last real hop's down pinned above auto", !(await enabled(downB("agnes-3.0-flash"))));
    check("B4 second-to-last real hop can move down", await enabled(downB("deepseek-v4-flash")));
  } catch (err) {
    failed += 1;
    console.log("FAIL  harness error —", err?.message ?? err);
  } finally {
    await browser.close();
  }
  console.log(`\n${passed}/${passed + failed} checks passed`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
