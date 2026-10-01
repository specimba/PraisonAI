#!/usr/bin/env node
// ─── r161 QA: Gateway pulse chip (T-series) ─────────────────────────────────
// T1  API: GET /api/gateway/pulse reflects a seeded db/gateway-pulse.json
//     (2-min-old event + counts correct) and returns 200 with the shape.
// T2  UI fresh state: workflows view mounts with a 2-min-old 429 on record →
//     amber "gateway 429 · last 2m ago · 2 in 24h" chip visible; tooltip
//     names the model and the server-seen-only scope. Screenshot.
// T3  UI silence = healthy: with an EMPTY pulse record the chip is absent
//     (no permanently-green noise, mirroring r160's CacheStatus decision).
//     Uses click-to-refresh (pointerdown per the r160 harness lesson) so the
//     assertion exercises the real re-fetch path, not just initial mount.
//
// Harness lessons applied (r159/r160): Radix/pointer targets need the full
// pointer sequence; the active view is persisted so a fresh tab may restore
// ANY view — navigation helpers wait-with-retry instead of trusting a cold
// tab to land where we want; atomic chrome on 9222, killed in finally.

import { chromium } from "playwright";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = "/home/z/my-project";
const PULSE_FILE = path.join(ROOT, "db", "gateway-pulse.json");
const QA_DIR = path.join(ROOT, "ops", "qa");
const BASE = "http://localhost:3000";

let passed = 0;
let failed = 0;
const results = [];

function check(name, ok, detail) {
  const entry = { name, ok, detail };
  results.push(entry);
  if (ok) passed += 1;
  else failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

function seedPulse(events) {
  fs.mkdirSync(path.dirname(PULSE_FILE), { recursive: true });
  fs.writeFileSync(PULSE_FILE, JSON.stringify({ events }), "utf8");
}

async function waitWithRetry(fn, timeoutMs = 15000, label = "condition") {
  const start = Date.now();
  let lastErr;
  while (Date.now() - start < timeoutMs) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`timeout waiting for ${label}${lastErr ? `: ${lastErr.message}` : ""}`);
}

/** Full pointer sequence — r160 lesson: Radix-less buttons still respond to
 * click(), but keep one helper so every activation is honest and uniform. */
async function activate(page, locator) {
  await locator.dispatchEvent("pointerdown", { button: 0 });
  await locator.dispatchEvent("pointerup", { button: 0 });
  await locator.click();
}

async function gotoWorkflows(page) {
  // The active view persists (zustand persist) — a fresh tab can restore
  // anything. Drive via the sidebar nav by label prefix (r150 lesson:
  // bundled label+hint nodes → startsWith).
  await waitWithRetry(
    async () => page.getByRole("button", { name: /^Workflows/ }).first(),
    20000,
    "Workflows nav button"
  );
  await activate(page, page.getByRole("button", { name: /^Workflows/ }).first());
  await waitWithRetry(
    () => page.locator("text=New Workflow").first().isVisible(),
    20000,
    "workflows view visible"
  );
}

async function main() {
  fs.mkdirSync(QA_DIR, { recursive: true });
  const now = Date.now();
  const browser = await chromium.launch({
    // r159/r160 harness convention: the playwright-managed headless shell
    // (no system chrome in this sandbox — /usr/bin/google-chrome doesn't exist).
    executablePath:
      "/home/z/.cache/ms-playwright/chromium_headless_shell-1200/chrome-headless-shell-linux64/chrome-headless-shell",
    args: ["--no-sandbox"],
  });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    // ── T1: API reflects the seeded record ────────────────────────────────
    seedPulse([
      { t: now - 26 * 60 * 60_000, model: "old-stale-model" }, // >24h: excluded from count24h
      { t: now - 90 * 60_000, model: "deep-model-9step" },     // in 24h, not 1h
      { t: now - 2 * 60_000, model: "research-scout-model" },  // in 1h (the fresh one)
    ]);
    const res = await fetch(`${BASE}/api/gateway/pulse`);
    const body = await res.json();
    check("T1a pulse API 200", res.status === 200, `status=${res.status}`);
    check(
      "T1b counts + last429At correct",
      body.count1h === 1 && body.count24h === 2 && body.last429At === now - 2 * 60_000,
      JSON.stringify(body)
    );

    // ── T2: fresh state → amber chip on the workflows view ────────────────
    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
    await gotoWorkflows(page);
    const chip = page.locator("button", { hasText: "gateway 429" }).first();
    await waitWithRetry(() => chip.isVisible(), 15000, "gateway chip visible");
    const chipText = (await chip.textContent()) || "";
    check(
      "T2a chip shows fresh 429 with counts",
      /last 2m ago/.test(chipText) && /2 in 24h/.test(chipText),
      chipText.trim()
    );
    const amber = await chip.getAttribute("class");
    check(
      "T2b fresh chip is amber-toned",
      !!amber && /amber/.test(amber),
      amber?.split(" ").filter((c) => /amber/.test(c)).join(" ")
    );
    const aria = await chip.getAttribute("aria-label");
    check(
      "T2c aria-label narrates the state",
      !!aria && /last rate limit 2m ago/.test(aria),
      aria || "(none)"
    );
    const tooltip = await chip.getAttribute("title");
    check(
      "T2d tooltip names the model + honest scope",
      !!tooltip && /research-scout-model/.test(tooltip) && /server-seen/.test(tooltip),
      (tooltip || "").split("\n").slice(0, 2).join(" | ")
    );
    await page.screenshot({ path: path.join(QA_DIR, "T-gateway-pulse-fresh.png"), fullPage: false });

    // ── T3: silence = healthy → chip absent after an explicit refresh ─────
    seedPulse([]); // gateway clear
    await activate(page, chip); // click-to-refresh (no polling — the chip re-fetches itself)
    await waitWithRetry(
      async () => !(await chip.isVisible().catch(() => false)),
      15000,
      "chip to disappear after refresh"
    );
    check("T3 empty record → chip absent (no green-noise)", true, "cleared via chip's own refresh");
    await page.screenshot({ path: path.join(QA_DIR, "T-gateway-pulse-clear.png"), fullPage: false });

    // Leave a TRUTHFUL record for the user — synthetic QA seeds must not
    // masquerade as observed congestion; the next real 429 starts clean.
    seedPulse([]);
  } finally {
    await browser.close().catch(() => {});
  }

  console.log(`\nT-series: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error("HARNESS ERROR:", e);
  process.exit(1);
});
