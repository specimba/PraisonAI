#!/usr/bin/env node
// ─── r169 QA: Your-Data card hardening (CD-series) ──────────────────────────
// The full-data import wrote bundle arrays straight into localStorage (zero
// per-entry validation — the exact gap r165 closed for the vault restore),
// and "Clear all data" removed only 5 hardcoded keys while claiming to wipe
// "everything stored in this browser" (relay health, live catalog, intro
// flags and the stall override survived). This harness proves the fixes:
//   D1  malformed import bundle → only structurally valid entries land;
//       junk message dropped, id-less real message gets a synthesized id;
//       workflow junk steps filtered; toast states the honest skipped count;
//       imported data REPLACES the baseline (no merge)
//   D2  settings:"garbage" (a string spreads as index keys when spread) is
//       replaced by defaults — no "0"/"1" poison keys, preseed vault intact
//   D3  clear-all wipes EVERY praison-* key (decoy non-praison key survives)
//   D4  (r173) import is confirm-gated: pick → a dialog states current-vs-
//       incoming counts; cancel = no write + no reload; confirm = replace
// Usage: node scripts/cdp-qa-settings-data.mjs [baseUrl]

import { chromium } from "playwright";

const BASE = process.argv[2] ?? "http://localhost:3000";

let passed = 0;
let failed = 0;
function check(name, ok, detail = "") {
  if (ok) passed += 1;
  else failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function openSettings(page) {
  const nav = page.getByRole("button", { name: /^Settings/ }).first();
  await nav.waitFor({ timeout: 20000 });
  await nav.dispatchEvent("pointerdown", { button: 0 });
  await nav.dispatchEvent("pointerup", { button: 0 });
  await nav.click();
  await page.locator("#data input[type='file']").waitFor({ timeout: 20000 });
}

async function importBundle(page, bundle) {
  const input = page.locator("#data input[type='file']");
  await input.setInputFiles({
    name: "export.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(bundle)),
  });
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
    // ── D1: sanitized import with honest skipped counts ──────────────────
    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" }).catch(() => {});
    await page.evaluate(() => {
      localStorage.setItem(
        "praison-agents",
        JSON.stringify({
          state: {
            agents: [
              { id: "seed-1", name: "Baseline One", instructions: "x" },
              { id: "seed-2", name: "Baseline Two", instructions: "y" },
            ],
          },
          version: 0,
        })
      );
    });
    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
    await openSettings(page);

    await importBundle(page, {
      exportedAt: new Date().toISOString(),
      agents: [
        { id: "a-ok", name: "Valid Agent", instructions: "Do things", emoji: "🤖", createdAt: 1, updatedAt: 1 },
        { id: "a-bad", name: "No Instructions" },
        "junk-string",
      ],
      conversations: [
        {
          id: "c-ok",
          messages: [
            { id: "m1", role: "user", content: "hello", createdAt: 1 },
            { id: "m2", role: "assistant", content: "hi", createdAt: 2 },
            { role: "assistant", content: "no id but real content", createdAt: 3 },
            { id: "m4", role: "system", content: "junk role" },
            "junk",
          ],
        },
        { id: "c-bad", messages: "not-an-array" },
      ],
      workflows: [
        { id: "w-ok", name: "Valid Flow", steps: [{ id: "s1" }, null, "junk"] },
        { id: "w-bad", name: "No Steps" },
      ],
      settings: { displayName: "Tester" },
    });
    // r173: the import no longer applies on pick — confirm the replace dialog.
    await page.getByRole("button", { name: /Replace & reload/ }).click();

    const toast = page.waitForSelector("[data-sonner-toast]", { timeout: 8000 });
    const toastText = (await (await toast).textContent()) ?? "";
    check("D1a toast reports honest skipped count", /4 malformed entries skipped/.test(toastText), toastText ?? "");
    check("D1b toast reports imported counts", /1 agents · 1 conversations · 1 workflows/.test(toastText));

    await page.waitForFunction(
      () => (localStorage.getItem("praison-agents") ?? "").includes("a-ok"),
      { timeout: 10000 }
    );
    const d1 = await page.evaluate(() => ({
      agents: JSON.parse(localStorage.getItem("praison-agents") ?? "{}")?.state?.agents,
      convs: JSON.parse(localStorage.getItem("praison-conversations") ?? "{}")?.state?.conversations,
      flows: JSON.parse(localStorage.getItem("praison-workflows") ?? "{}")?.state?.workflows,
      settings: JSON.parse(localStorage.getItem("praison-settings") ?? "{}")?.state?.settings,
    }));
    check("D1c import REPLACES baseline agents", d1.agents?.length === 1 && d1.agents[0]?.id === "a-ok",
      `ids=${JSON.stringify(d1.agents?.map((a) => a.id))}`);
    const msgs = d1.convs?.[0]?.messages ?? [];
    check(
      "D1d junk messages dropped, id-less real message synthesized",
      msgs.length === 3 && typeof msgs[2]?.id === "string" && msgs[2].id.includes("-imp-"),
      `count=${msgs.length} last=${JSON.stringify(msgs[2])}`
    );
    check("D1e workflow junk steps filtered", d1.flows?.length === 1 && d1.flows[0]?.steps?.length === 1,
      `flows=${JSON.stringify(d1.flows?.map((w) => [w.id, w.steps?.length]))}`);
    check("D1f settings object merged (displayName)", d1.settings?.displayName === "Tester");

    // ── D2 (continues on the loaded page): junk settings cannot poison ───
    await importBundle(page, {
      exportedAt: new Date().toISOString(),
      agents: [],
      conversations: [],
      workflows: [],
      settings: "garbage",
    });
    await page.getByRole("button", { name: /Replace & reload/ }).click();
    await page.waitForFunction(
      () => {
        const raw = localStorage.getItem("praison-settings");
        if (!raw) return false;
        const s = JSON.parse(raw)?.state?.settings;
        return s && !("0" in s) && typeof s.displayName === "string";
      },
      { timeout: 10000 }
    );
    const d2 = await page.evaluate(() => {
      const s = JSON.parse(localStorage.getItem("praison-settings"))?.state?.settings;
      return {
        noIndexKeys: !("0" in s) && !("1" in s),
        preseedIntact: typeof s.providerKeys?.vyce?.key === "string" && s.providerKeys.vyce.key.length > 0,
        defaultName: s.displayName === "",
      };
    });
    check("D2a string settings replaced by defaults (no index-key poison)", d2.noIndexKeys);
    check("D2b vault preseed intact after guarded merge", d2.preseedIntact);

    // ── D3: clear-all wipes every praison-* key, spares foreign keys ─────
    await page.evaluate(() => {
      localStorage.setItem("praison-relay-health", JSON.stringify({ hops: {} }));
      localStorage.setItem("praison-free-catalog", JSON.stringify({ vyce: [] }));
      localStorage.setItem("praison-vyce-intro", "1");
      localStorage.setItem("not-praison", "keep-me");
    });
    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
    await openSettings(page);
    // The wipe runs synchronously inside the click handler and location.reload()
    // kills the context in the SAME task — no interval can observe the interim
    // state. Instrument removeItem instead: sessionStorage survives the reload.
    await page.evaluate(() => {
      sessionStorage.setItem("qa-removed", "[]");
      const orig = Storage.prototype.removeItem;
      Storage.prototype.removeItem = function (k) {
        const key = String(k);
        if (key.startsWith("praison-")) {
          const log = JSON.parse(sessionStorage.getItem("qa-removed") ?? "[]");
          log.push(key);
          sessionStorage.setItem("qa-removed", JSON.stringify(log));
        }
        return orig.call(this, k);
      };
    });
    await page.getByRole("button", { name: /Clear all data/ }).click();
    await page.getByRole("button", { name: /Yes, wipe everything/ }).click();
    await page.waitForTimeout(2500);
    const d3 = await page.evaluate(() => ({
      removed: JSON.parse(sessionStorage.getItem("qa-removed") ?? "[]"),
      decoy: localStorage.getItem("not-praison"),
    }));
    const required = ["praison-relay-health", "praison-free-catalog", "praison-vyce-intro", "praison-settings"];
    const allGone = required.every((k) => d3.removed.includes(k));
    check("D3a every praison-* key removed (incl. non-store keys)", allGone,
      `removed=${JSON.stringify(d3.removed)}`);
    check("D3b non-praison keys survive", d3.decoy === "keep-me", `decoy=${d3.decoy}`);

    // ── D4 (r173): import is confirm-gated — cancel is a total no-op ─────
    await openSettings(page);
    const d4Bundle = {
      exportedAt: new Date().toISOString(),
      agents: [
        { id: "qa-d4-agent", name: "D4 Agent", instructions: "confirm-gate", createdAt: 1, updatedAt: 1 },
      ],
      conversations: [],
      workflows: [],
      settings: { displayName: "D4" },
    };
    await importBundle(page, d4Bundle);
    await page.getByRole("alertdialog").waitFor({ timeout: 8000 });
    const d4desc = (await page.getByRole("alertdialog").textContent()) ?? "";
    check(
      "D4a import opens the replace-confirm dialog",
      d4desc.includes("Replace current data with this import?"),
      d4desc.slice(0, 120)
    );
    check(
      "D4b dialog states both sides (current vs incoming)",
      /currently holds \d+ agents/.test(d4desc) &&
        /The file contains 1 agent/.test(d4desc) &&
        /nothing is merged or backed up/.test(d4desc),
      d4desc.slice(0, 220)
    );
    // Cancel → nothing written, no reload (a window flag survives only
    // when the page is NOT reloaded).
    await page.evaluate(() => {
      window.__qaNoReload = true;
    });
    await page.getByRole("button", { name: "Cancel" }).click();
    await page.waitForTimeout(1500);
    const d4cancel = await page.evaluate(() => ({
      alive: window.__qaNoReload === true,
      dialogGone: document.querySelector("[role='alertdialog']") === null,
      store: localStorage.getItem("praison-agents") ?? "",
    }));
    check(
      "D4c cancel = no write, no reload, dialog closes",
      d4cancel.alive && d4cancel.dialogGone && !d4cancel.store.includes("qa-d4-agent"),
      `alive=${d4cancel.alive} gone=${d4cancel.dialogGone}`
    );
    // Confirm → replaces and reloads (same file re-picked: the input value
    // is reset on change, so re-picking fires onChange again).
    await importBundle(page, d4Bundle);
    await page.getByRole("button", { name: /Replace & reload/ }).click();
    await page.waitForFunction(
      () => (localStorage.getItem("praison-agents") ?? "").includes("qa-d4-agent"),
      { timeout: 10000 }
    );
    const d4done = await page.evaluate(
      () => JSON.parse(localStorage.getItem("praison-agents"))?.state?.agents
    );
    check(
      "D4d confirm replaces state with the file's contents",
      d4done?.length === 1 && d4done[0]?.id === "qa-d4-agent",
      `agents=${JSON.stringify(d4done?.map((a) => a.id))}`
    );
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
