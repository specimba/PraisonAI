#!/usr/bin/env node
// ─── r165 QA: vault restore hardening (Y-series) ────────────────────────────
// The vault restore path merged imported entries with NO per-entry
// sanitization and dropped two of the four fields the export saves
// (provider/defaultModel) — so a vault moved to a fresh browser restored the
// key but never REACTIVATED the provider (the gallery only honors
// activeProviderId when provider === "custom"). Live checks:
//   Y1  per-entry sanitization: valid entries survive with ONLY known
//       well-typed fields; malformed entries skipped with an honest count
//   Y2  full reactivation: vault with provider:"custom" + activeProviderId
//       flips the app onto that provider (card reads "Active provider",
//       store provider/defaultModel restored) — the dropped-fields regression
//   Y4  unusable active (provider with no key) is NOT restored
//   Y5  vault with provider:"auto" restores auto (leaves no card active)
// Usage: node scripts/cdp-qa-vault-restore.mjs [baseUrl]

import { chromium } from "playwright";

const BASE = process.argv[2] ?? "http://localhost:3000";

let passed = 0;
let failed = 0;
function check(name, ok, detail = "") {
  if (ok) passed += 1;
  else failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

function vaultFile(vault) {
  return {
    name: "vault.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(vault)),
  };
}

async function gotoSettings(page) {
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  const nav = page.getByRole("button", { name: /^Settings/ }).first();
  await nav.waitFor({ timeout: 20000 });
  // full pointer sequence (r160 lesson)
  await nav.dispatchEvent("pointerdown", { button: 0 });
  await nav.dispatchEvent("pointerup", { button: 0 });
  await nav.click();
  await page.getByText("Free frontier providers").first().waitFor({ timeout: 20000 });
}

async function restore(page, vault) {
  const input = page.locator("#providers input[type='file']");
  await input.setInputFiles(vaultFile(vault));
  await page.waitForTimeout(700);
}

async function storedSettings(page) {
  return page.evaluate(() => {
    const raw = localStorage.getItem("praison-settings");
    return raw ? JSON.parse(raw)?.state?.settings ?? JSON.parse(raw)?.state ?? {} : {};
  });
}

async function providerCard(page, name) {
  // The card's actions row only renders when EXPANDED — locate via the
  // header button (r165 probe lesson) and step up to the card wrapper.
  const header = page.locator("button[aria-expanded]", { hasText: name }).first();
  return header.locator("xpath=..");
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
    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" }).catch(() => {});
    // Fresh profile: default provider is "auto" — exactly the fresh-browser
    // scenario the reactivation fix targets. Nothing to seed.
    await gotoSettings(page);

    // Y1: sanitization — 2 valid entries (groq known, future_prov unknown id
    // kept for forward-compat), 3 malformed skipped
    await restore(page, {
      providerKeys: {
        groq: { key: "gsk_test_123", model: "llama/good", accountId: "acct-1", validatedAt: 1_700_000_000_000, junk: "strip-me" },
        future_prov: { key: "fp_1" },
        junk_obj: { key: { evil: true } },
        junk_str: "not-an-entry",
        junk_num: 42,
      },
    });
    const toast1 = await page.getByText(/Vault restored — 2 provider keys merged/).first().isVisible().catch(() => false);
    check("Y1a honest count: 2 keys merged", toast1);
    const skip1 = await page.getByText(/3 malformed entries skipped/).first().isVisible().catch(() => false);
    check("Y1b 3 malformed entries skipped", skip1);
    const s1 = await storedSettings(page);
    const groq = s1?.providerKeys?.groq;
    check(
      "Y1c groq entry keeps only known well-typed fields",
      groq?.key === "gsk_test_123" &&
        groq?.model === "llama/good" &&
        groq?.accountId === "acct-1" &&
        groq?.validatedAt === 1_700_000_000_000 &&
        groq?.junk === undefined,
      JSON.stringify(groq)
    );
    check("Y1d unknown provider id kept (forward-compat)", s1?.providerKeys?.future_prov?.key === "fp_1");
    check("Y1e junk ids absent", s1?.providerKeys?.junk_obj === undefined && s1?.providerKeys?.junk_str === undefined);

    // Y2: THE regression — vault says provider:"custom" + activeProviderId:"groq"
    // + defaultModel; a fresh browser sat on "auto" and must flip to custom
    await restore(page, {
      providerKeys: { groq: { key: "gsk_test_123", model: "llama/good" } },
      activeProviderId: "groq",
      provider: "custom",
      defaultModel: "llama/good",
    });
    const s2 = await storedSettings(page);
    check("Y2a store provider flipped to custom", s2?.provider === "custom", String(s2?.provider));
    check("Y2b activeProviderId restored", s2?.activeProviderId === "groq", String(s2?.activeProviderId));
    check("Y2c defaultModel restored", s2?.defaultModel === "llama/good", String(s2?.defaultModel));
    const groqCard = await providerCard(page, "Groq");
    await page.waitForTimeout(300);
    const ring = (await groqCard.getAttribute("class")) ?? "";
    check("Y2d collapsed card carries the active ring", ring.includes("border-violet-500/60"), ring.slice(0, 60));
    await groqCard.locator("button[aria-expanded]").first().click();
    const activeBtn = await groqCard.getByRole("button", { name: "Active provider" }).isVisible().catch(() => false);
    check("Y2e expanded card reads 'Active provider'", activeBtn);
    await groqCard.locator("button[aria-expanded]").first().click(); // collapse again

    // Y4: unusable active (no key for cerebras) must NOT flip anything
    await restore(page, { providerKeys: {}, activeProviderId: "cerebras", provider: "custom" });
    const s4 = await storedSettings(page);
    check("Y4a activeProviderId stays groq", s4?.activeProviderId === "groq", String(s4?.activeProviderId));
    check("Y4b provider stays custom (unchanged)", s4?.provider === "custom");

    // Y5: vault on the auto lane restores auto — no card stays active
    await restore(page, { providerKeys: { groq: { key: "gsk_test_123" } }, provider: "auto" });
    const s5 = await storedSettings(page);
    check("Y5a provider restored to auto", s5?.provider === "auto", String(s5?.provider));
    const groq5 = await providerCard(page, "Groq");
    const ring5 = (await groq5.getAttribute("class")) ?? "";
    check("Y5b no active ring on auto", !ring5.includes("border-violet-500/60"), ring5.slice(0, 60));
    await groq5.locator("button[aria-expanded]").first().click();
    const useBtn = await groq5.getByRole("button", { name: "Use this provider" }).isVisible().catch(() => false);
    check("Y5c expanded card reads 'Use this provider'", useBtn);
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
