#!/usr/bin/env node
// ─── r168 QA: relay reorder affordance (AA-series v2, registry-robust) ──────
// r167 shipped the reorder-pin fix (model-relay.tsx: reorder indices come from
// the filtered non-auto list; pin logic uses orderCount) but its harness died
// with the session: it hardcoded a 6-row vyce-only chain, while a fresh
// profile actually carries the r18/r30 vault preseed (vyce + aihubmix +
// pollinations are ALL keyed — buildRelayChain only emits keyed providers, so
// the real default chain renders 19 hops). v2 asserts structural invariants
// on the RENDERED rows instead of registry identities, so catalog edits can
// never silently re-break this gate.
//   A1  auto primary → no "Built-in engine" row; chain renders N >= 3 rows
//   A2  THE BUG: second-to-last row CAN move down (was wrongly pinned); last
//       row's down + first row's up stay pinned; second-to-last can move up
//   A3  swapping the tail persists relayOrder: full permutation (N unique
//       keys) with the tail pair in swapped order
//   A4  DOM reflects the swap (old last row now sits above old second-to-last)
//   B1  custom primary → auto row present, pinned LAST, renders no arrows
//   B2  last REAL hop's down disabled above auto; second-to-last CAN move down
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

async function seedAndOpen(page, settingsPatch) {
  // r262: seed lands on the bare JSON page (zero app JS) — writing while the
  // app root was live let its debounced persist clobber the seed before the
  // second goto re-hydrated it (J5 race doctrine, r259-r261).
  await page.goto(`${BASE}/api/providers/free-models`, { waitUntil: "domcontentloaded" }).catch(() => {});
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

/** Label of a row's hop, taken from its Move-down button's aria-label. */
async function rowLabel(row) {
  const btn = row.getByRole("button", { name: / down$/ }).first();
  const aria = await btn.getAttribute("aria-label", { timeout: 5000 });
  return aria.replace(/^Move /, "").replace(/ down$/, "");
}

/** Model fragment of a "Provider · model" hop label (collision-guarded use). */
function modelFrag(label) {
  const parts = label.split("·");
  return parts.slice(1).join("·").trim();
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
      providerKeys: { vyce: { key: "vyce_test_key" } },
    });
    const rows = card.locator('[role="listitem"]');
    const n = await rows.count();
    check("A1a chain renders N >= 3 hops", n >= 3, `count=${n}`);
    // Scope to listitems — the card DESCRIPTION also contains the phrase
    // "built-in engine", which strict-modes a bare getByText.
    check(
      "A1b no 'Built-in engine' row on auto primary",
      (await card.locator('[role="listitem"]', { hasText: "Built-in engine" }).count()) === 0
    );

    const downOf = (row) => row.getByRole("button", { name: / down$/ }).first();
    const upOf = (row) => row.getByRole("button", { name: / up$/ }).first();
    const isEnabled = async (btn) => btn.isEnabled().catch(() => false);

    const first = rows.nth(0);
    const secondLast = rows.nth(n - 2);
    const last = rows.nth(n - 1);

    // THE BUG — the second-to-last REAL hop was wrongly pinned before r167.
    check("A2a second-to-last hop CAN move down (was wrongly pinned)", await isEnabled(downOf(secondLast)));
    check("A2b last hop's down stays pinned", !(await isEnabled(downOf(last))));
    check("A2c first hop's up stays pinned", !(await isEnabled(upOf(first))));
    check("A2d second-to-last hop CAN still move up", await isEnabled(upOf(secondLast)));

    // A3: swap the tail pair → relayOrder persists as a full permutation.
    const labelLast = await rowLabel(last);
    const labelSL = await rowLabel(secondLast);
    await downOf(secondLast).click();
    await page.waitForTimeout(500);
    const stored = await page.evaluate(() => {
      const raw = localStorage.getItem("praison-settings");
      return raw ? JSON.parse(raw)?.state?.settings?.relayOrder : undefined;
    });
    const uniq = Array.isArray(stored) ? new Set(stored).size : 0;
    check(
      "A3a relayOrder persisted as full permutation",
      Array.isArray(stored) && stored.length === n && uniq === n,
      `len=${Array.isArray(stored) ? stored.length : "n/a"} uniq=${uniq} n=${n}`
    );
    // After the swap the OLD last hop sits at index n-2 and the OLD
    // second-to-last at n-1. Match on model fragments with a bijection guard
    // (the same model id can exist under two providers).
    const fLast = modelFrag(labelLast);
    const fSL = modelFrag(labelSL);
    const t0 = stored?.[n - 2] ?? "";
    const t1 = stored?.[n - 1] ?? "";
    const tailSwapped =
      (t0.endsWith(`::${fLast}`) && t1.endsWith(`::${fSL}`)) ||
      (t0.endsWith(`::${fSL}`) && t1.endsWith(`::${fLast}`));
    check("A3b relayOrder tail pair swapped", tailSwapped, `tail=[${t0}, ${t1}]`);

    // A4: DOM reflects the swap — old-last row now ABOVE old-second-to-last.
    const boxLast = await card
      .locator('[role="listitem"]', { hasText: labelLast })
      .first()
      .boundingBox();
    const boxSL = await card
      .locator('[role="listitem"]', { hasText: labelSL })
      .first()
      .boundingBox();
    check(
      "A4 swap visible in DOM order",
      !!boxLast && !!boxSL && boxLast.y < boxSL.y,
      `yLast=${boxLast?.y} ySL=${boxSL?.y}`
    );

    // ── Scenario B: custom primary — auto hop PRESENT (pinned last)
    const cardB = await seedAndOpen(page, {
      provider: "custom",
      activeProviderId: "vyce",
      providerKeys: { vyce: { key: "vyce_test_key", model: "deepseek-v4.1" } },
      relayOrder: [],
    });
    const rowsB = cardB.locator('[role="listitem"]');
    const nB = await rowsB.count();
    check(
      "B1a 'Built-in engine' row present on custom primary (exactly one)",
      (await cardB.locator('[role="listitem"]', { hasText: "Built-in engine" }).count()) === 1
    );
    const autoRow = rowsB.nth(nB - 1);
    check(
      "B1b auto row is pinned LAST in the chain",
      (await autoRow.textContent())?.includes("Built-in engine") ?? false
    );
    check("B2a auto row renders no reorder arrows", (await autoRow.getByRole("button").count()) === 0);
    const lastReal = rowsB.nth(nB - 2);
    const secondLastReal = rowsB.nth(nB - 3);
    check("B2b last real hop's down pinned above auto", !(await isEnabled(downOf(lastReal))));
    check("B2c second-to-last real hop can move down", await isEnabled(downOf(secondLastReal)));
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
