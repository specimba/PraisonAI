#!/usr/bin/env node
// ─── r170 QA: Local models panel honest states (EF-series, smoke) ───────────
// Headless chrome has NO WebGPU adapter — which makes it a real fixture for
// the panel's degraded paths: the capability card must tell the truth about
// the device, the catalog must still render CPU-friendly entries, the HF
// gallery must filter, and (after the r170 fix) no code path may leave a
// "thinking…" spinner on a terminal empty bubble. The WebLLM engine itself
// cannot load in headless (no GPU) — the spinner fix is verified by the
// render guard + per-path finalize notes (see local-models.tsx r170 blocks).
//   E1  panel renders on the settings surface
//   E2  an honest capability explainer is visible (no-WebGPU / probe error /
//       fallback adapter — headless is one of these)
//   E3  catalog renders rows OR the honest "0 models fit your budget" line
//   E4  size-tier filter is an interactive radiogroup (aria-checked moves)
//   E5  HF field-examples gallery renders at least one example
// Usage: node scripts/cdp-qa-local-models.mjs [baseUrl]

import { chromium } from "playwright";

const BASE = process.argv[2] ?? "http://localhost:3000";

let passed = 0;
let failed = 0;
function check(name, ok, detail = "") {
  if (ok) passed += 1;
  else failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
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
    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
    const nav = page.getByRole("button", { name: /^Settings/ }).first();
    await nav.waitFor({ timeout: 20000 });
    await nav.dispatchEvent("pointerdown", { button: 0 });
    await nav.dispatchEvent("pointerup", { button: 0 });
    await nav.click();
    const panel = page.getByTestId("local-models-panel");
    await panel.waitFor({ timeout: 20000 });

    // E1: panel present
    check("E1 local models panel renders", await panel.isVisible());

    // Give the async GPU probe a moment, then read the honest state.
    await page.waitForTimeout(1500);
    const panelText = (await panel.textContent()) ?? "";
    const honestExplainer =
      /GPU probe failed|No WebGPU adapter|secure context|software-fallback|lacks the/i.test(panelText);
    const gpuReport = await panel.getByTestId("gpu-report").count();
    check(
      "E2 honest capability state (explainer or real GPU report)",
      honestExplainer || gpuReport > 0,
      `explainer=${honestExplainer} gpuReport=${gpuReport}`
    );
    if (honestExplainer) {
      const matched = panelText.match(/GPU probe failed|No WebGPU adapter|secure context|software-fallback/i);
      console.log(`      headless device truth: ${matched?.[0]}`);
    }

    // E3: catalog renders something usable — rows, or the honest zero line
    const budgetLine = /model(s)? fit your budget/.test(panelText);
    const zeroLine = /0 models fit your budget/.test(panelText);
    const rows = await panel.locator("text=/VRAM/").count();
    check(
      "E3 catalog honest (rows or explicit zero line)",
      budgetLine && (zeroLine || rows > 0),
      `budgetLine=${budgetLine} zeroLine=${zeroLine} rows=${rows}`
    );

    // E4: size filter is a real radiogroup
    const radios = panel.locator('[role="radio"][aria-label], [role="radio"]');
    const radioCount = await radios.count();
    if (radioCount > 0) {
      const before = await radios.nth(0).getAttribute("aria-checked");
      await radios.nth(1).click();
      await page.waitForTimeout(150);
      const after = await radios.nth(1).getAttribute("aria-checked");
      const first = await radios.nth(0).getAttribute("aria-checked");
      check(
        "E4 size filter toggles aria-checked",
        before === "true" && after === "true" && first === "false",
        `before=${before} after=${after} first=${first}`
      );
    } else {
      check("E4 size filter toggles aria-checked", false, "no radios found");
    }

    // E5: HF field examples render
    const examples = panel.locator('a[href*="huggingface.co/spaces"]');
    const exampleCount = await examples.count();
    check("E5 HF field examples render", exampleCount > 0, `count=${exampleCount}`);
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
