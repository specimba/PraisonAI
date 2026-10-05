#!/usr/bin/env node
// ─── r164 QA: agent form dialog affordances (X-series) ──────────────────────
// The form dialog had three real gaps: unexplained technical sliders, a
// UTF-16 maxLength that halved flag emoji, and silent loss of edits on
// Esc/backdrop. Live checks on a throwaway profile, seeded localStorage:
//   X1  helper text under BOTH sliders ("focused and repeatable" / "grace steps")
//   X2  dirty guard: edit instructions → Esc → "Discard changes?" appears;
//       "Keep editing" keeps the dialog open; Esc → "Discard" closes AND the
//       store keeps the ORIGINAL instructions (discard really discards)
//   X3  clean close: reopen, Esc with no edits → closes with NO confirm
//   X4  flag emoji: set 🇺🇸 (4 UTF-16 units — impossible under maxLength=2),
//       save → the roster card renders the full flag grapheme
//   X5  honest submit labels: "Save changes" in edit mode, "Create agent" in
//       create mode (was "Save"/"Save")
// Usage: node scripts/cdp-qa-agent-form.mjs [baseUrl]

import { chromium } from "playwright";

const BASE = process.argv[2] ?? "http://localhost:3000";

let passed = 0;
let failed = 0;
function check(name, ok, detail = "") {
  if (ok) passed += 1;
  else failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const NOW = Date.now();
const AGENT = {
  id: "agent_form",
  name: "Form Probe",
  emoji: "🤖",
  color: "violet",
  role: "prober",
  description: "checks the form",
  instructions: "ORIGINAL INSTRUCTIONS",
  model: "auto",
  temperature: 0.7,
  maxIterations: 6,
  tools: [],
  createdAt: NOW,
  updatedAt: NOW,
};

async function gotoAgents(page) {
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  const nav = page.getByRole("button", { name: /^Agents/ }).first();
  await nav.waitFor({ timeout: 20000 });
  // full pointer sequence (r160 lesson)
  await nav.dispatchEvent("pointerdown", { button: 0 });
  await nav.dispatchEvent("pointerup", { button: 0 });
  await nav.click();
  await page.locator("text=Agent Roster").first().waitFor({ timeout: 20000 });
}

async function openEdit(page) {
  const card = page.locator('[role="button"]', { hasText: "Form Probe" }).first();
  await card.locator('button[aria-label^="Actions for"]').click();
  await page.getByRole("menuitem", { name: "Edit" }).click();
  await page.locator("#agent-instructions").waitFor({ timeout: 10000 });
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
    // Seed BEFORE first load (reads are plain localStorage; writes are debounced).
    // r262: seed lands on the bare JSON page (zero app JS) — writing while
    // the app root was live let its debounced persist clobber the seed
    // before gotoAgents re-hydrated it (J5 race doctrine, r259-r261).
    await page.goto(`${BASE}/api/providers/free-models`, { waitUntil: "domcontentloaded" }).catch(() => {});
    await page.evaluate(([agent]) => {
      localStorage.setItem("praison-agents", JSON.stringify({ state: { agents: [agent] }, version: 1 }));
    }, [AGENT]);

    await gotoAgents(page);

    // X5a + X1: edit mode labels and slider helper text
    await openEdit(page);
    const submit = page.locator('button[type="submit"]');
    check("X5a edit mode submit says 'Save changes'", (await submit.textContent())?.trim() === "Save changes");
    check("X1a temperature helper visible", await page.getByText("focused and repeatable").isVisible());
    check("X1b iterations helper visible", await page.getByText("grace steps").isVisible());

    // X2: dirty guard on Esc, keep-editing, then real discard
    const instr = page.locator("#agent-instructions");
    await instr.fill("ORIGINAL INSTRUCTIONS EDITED");
    await page.keyboard.press("Escape");
    const confirm = page.getByText("Discard changes?");
    await confirm.waitFor({ timeout: 5000 });
    check("X2a Esc with edits opens discard confirm", await confirm.isVisible());
    await page.getByRole("button", { name: "Keep editing" }).click();
    await page.waitForTimeout(300);
    check("X2b 'Keep editing' keeps the form open", await instr.isVisible());
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Discard", exact: true }).click();
    await page.waitForTimeout(400);
    check("X2c Discard closes the form", !(await instr.isVisible().catch(() => false)));
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("praison-agents") ?? "{}"));
    const kept = stored?.state?.agents?.find((a) => a.id === "agent_form");
    check("X2d store keeps ORIGINAL instructions after discard", kept?.instructions === "ORIGINAL INSTRUCTIONS", kept?.instructions);

    // X3: clean close with no edits → no confirm
    await openEdit(page);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
    check("X3 clean Esc closes without confirm", !(await instr.isVisible().catch(() => false)) && !(await confirm.isVisible().catch(() => false)));

    // X4: flag emoji survives to the card
    await openEdit(page);
    const emoji = page.locator("#agent-emoji");
    await emoji.fill("🇺🇸");
    await submit.click();
    await page.waitForTimeout(600);
    const card = page.locator('[role="button"]', { hasText: "Form Probe" }).first();
    const cardText = (await card.textContent()) ?? "";
    check("X4 flag emoji 🇺🇸 survives to the card", cardText.includes("🇺🇸"), cardText.slice(0, 60));

    // X5b: create mode submit label
    await page.getByRole("button", { name: "New Agent" }).first().click();
    await page.locator("#agent-name").waitFor({ timeout: 10000 });
    check("X5b create mode submit says 'Create agent'", (await page.locator('button[type="submit"]').textContent())?.trim() === "Create agent");
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
