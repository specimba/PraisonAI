#!/usr/bin/env node
// ─── r166 QA: GatewayPulse chip vs REAL data (Z-series, READ-ONLY) ──────────
// The pulse ring has been empty since r161 shipped it — today the first real
// 429s landed (the user's pipeline dialing through the congested free-tier
// gateway). This is the first time the chip renders against genuine data, so
// this QA is strictly READ-ONLY: no localStorage seeding, no pulse-file
// reseeding, no cleanup afterwards — the record is the user's live data.
//   Z1  chip renders on the workflows view with the real counts
//   Z2  tone matches the age of the last event (amber <10min, gray otherwise)
//   Z3  tooltip lists the recent events (per-event lines)
//   Z4  click-to-refresh works (egress doctrine: explicit, not polled)
// Usage: node scripts/cdp-qa-gateway-pulse-live.mjs [baseUrl]

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
  const page = await (await browser.newContext()).newPage();

  try {
    // Fresh API read FIRST (the truth the chip must agree with).
    const api = await page.request.get(`${BASE}/api/gateway/pulse`);
    const pulse = await api.json();
    check("Z0 real data present (read-only QA)", pulse?.count24h > 0 && pulse?.last429At != null, JSON.stringify({ count24h: pulse?.count24h }));

    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
    const nav = page.getByRole("button", { name: /^Workflows/ }).first();
    await nav.waitFor({ timeout: 20000 });
    await nav.dispatchEvent("pointerdown", { button: 0 });
    await nav.dispatchEvent("pointerup", { button: 0 });
    await nav.click();

    const chip = page.locator("button", { hasText: /gateway 429/ }).first();
    await chip.waitFor({ timeout: 15000 });

    // Z1: text carries the real counts (count may grow while QA runs — assert
    // the shape and that the shown 24h count is at least the API's snapshot)
    const text = ((await chip.textContent()) ?? "").replace(/\s+/g, " ").trim();
    const m = text.match(/(\d+) in 24h/);
    check("Z1 chip renders 'gateway 429 · last Xm ago · N in 24h'", /gateway 429 · last .+ ago · \d+ in 24h/.test(text), text);
    check("Z1b shown count ≥ API snapshot", m != null && Number(m[1]) >= pulse.count24h, `shown=${m?.[1]} snapshot=${pulse.count24h}`);

    // Z2: tone matches the age of the last event
    const cls = (await chip.getAttribute("class")) ?? "";
    const ageMs = Date.now() - pulse.last429At;
    const expectAmber = ageMs < 10 * 60_000 - 2_000; // 2s boundary guard
    const isAmber = cls.includes("amber-500");
    const isGray = cls.includes("bg-muted/40");
    check(
      "Z2 tone matches event age",
      expectAmber ? isAmber : isGray,
      `age=${Math.round(ageMs / 1000)}s expected=${expectAmber ? "amber" : "gray"} class=${cls.slice(0, 70)}`
    );

    // Z3: tooltip lists the recent events (per-event lines, oldest→newest reversed)
    const title = (await chip.getAttribute("title")) ?? "";
    const lines = title.split("\n").filter((l) => l.startsWith("· "));
    check("Z3 tooltip lists recent events", lines.length >= Math.min(pulse.recent.length, 8), `${lines.length} lines`);

    // Z4: click-to-refresh (explicit egress) — chip still renders, busy spinner path runs
    await chip.click();
    await page.waitForTimeout(600);
    const after = ((await chip.textContent()) ?? "").replace(/\s+/g, " ").trim();
    check("Z4 click-refresh keeps the chip truthful", /gateway 429 · last .+ ago · \d+ in 24h/.test(after), after);

    await page.screenshot({ path: "ops/qa/Z-gateway-pulse-live.png", fullPage: false });
    console.log("screenshot: ops/qa/Z-gateway-pulse-live.png");
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
