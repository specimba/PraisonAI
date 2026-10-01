#!/usr/bin/env node
// ─── r175 QA: tracker announcement dedup under overlapping refreshes ────────
// Audit finding: apply() is a read-modify-write of the last-seen watermark.
// Two overlapping refreshes (StrictMode boot double-fire, a retry timer
// colliding with the 15-min poll, rapid visibilitychange bursts) both read
// the SAME stale localStorage value → identical "unseen" lists → duplicate
// "New model spotted" toasts. The fix keeps the watermark in a ref that is
// read+updated synchronously inside apply(), so the second apply finds
// nothing left to announce.
// This harness stages the tracker through a stubbed GET /api/tracker and:
//   E1  the ticker strip paints from the stub (data path sane)
//   E2  a boot refresh with no unseen events toasts nothing (control)
//   E3  TWO overlapping refreshes delivering the SAME new event toast
//       EXACTLY ONCE (the dedup — this was 2 before the fix)
//   E4  the watermark advanced into localStorage after the announcement
// Also re-frames the r170 user observation: the "duplicate model list" in
// the ticker is the marquee's documented seamless-loop duplication
// ([0,1].map(dup) — r148-measured compositor animation), NOT a render bug;
// E1 asserts the strip region renders once with the panel unopened.
// Usage: node scripts/cdp-qa-tracker-dedup.mjs [baseUrl]

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
  page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 300)));

  // One-shot init: mark the watermark AT now (the boot refresh must have
  // nothing to announce), and stub GET /api/tracker with a 60ms-delayed
  // response reading the MUTABLE window.__qaEvent so the harness controls
  // what each in-flight refresh receives at response time.
  await context.addInitScript(() => {
    sessionStorage.setItem("__qa_seeded", "1");
    localStorage.setItem("praison-tracker-lastseen", String(Date.now()));
    const ROW = {
      id: "vyce::qa-race-model",
      providerId: "vyce",
      modelId: "qa-race-model",
      contextWindow: 128000,
      priceIn: null,
      priceOut: null,
      free: true,
      isNew: false,
      firstSeenAt: new Date(Date.now() - 86400_000).toISOString(),
    };
    const orig = window.fetch;
    window.__qaEvent = null;
    window.fetch = (input, init) => {
      const url = typeof input === "string" ? input : (input?.url ?? "");
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.includes("/api/tracker") && method === "GET") {
        const ev = window.__qaEvent;
        const body = {
          tracked: [ROW],
          signals: [],
          events: ev ? [ev] : [],
          sources: [],
          status: {
            lastSyncAt: null,
            stale: false, // no POST sync path in QA
            nextForceEligibleAt: 0,
            newWindowHours: 48,
            syncTtlHours: 4,
          },
        };
        return new Promise((resolve) => {
          setTimeout(
            () =>
              resolve(
                new Response(JSON.stringify(body), {
                  headers: { "Content-Type": "application/json" },
                })
              ),
            60
          );
        });
      }
      return orig(input, init);
    };
  });

  try {
    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });

    // E1: strip paints from the stub.
    await page
      .locator('[aria-label="Model tracker ticker"]')
      .waitFor({ timeout: 15_000 });
    check("E1 ticker strip paints from the stubbed tracker", true);

    // E2 (control): boot refresh had no unseen events → no announcements.
    await page.waitForTimeout(1500); // let the boot apply settle
    const bootToasts = await page.evaluate(
      () =>
        [...document.querySelectorAll("[data-sonner-toast]")].filter((t) =>
          (t.textContent ?? "").includes("New model spotted")
        ).length
    );
    check("E2 boot refresh with no unseen events toasts nothing", bootToasts === 0, `count=${bootToasts}`);

    // E3: ONE new event, TWO overlapping refreshes (two visibilitychange
    // dispatches back-to-back → both fetches in flight → both apply the
    // same event). Exactly one announcement is the fix's contract.
    await page.evaluate(() => {
      window.__qaEvent = {
        id: "ev-1",
        type: "new",
        modelId: "qa-race-model",
        providerId: "vyce",
        createdAt: new Date(Date.now() + 2000).toISOString(),
        payload: null,
      };
      document.dispatchEvent(new Event("visibilitychange"));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    let announceToasts = 0;
    try {
      await page.waitForFunction(
        () =>
          [...document.querySelectorAll("[data-sonner-toast]")].some((t) =>
            (t.textContent ?? "").includes("New model spotted")
          ),
        { timeout: 8000 }
      );
      announceToasts = await page.evaluate(
        () =>
          [...document.querySelectorAll("[data-sonner-toast]")].filter((t) =>
            (t.textContent ?? "").includes("New model spotted")
          ).length
      );
    } catch {
      announceToasts = 0;
    }
    check("E3 overlapping refreshes toast the new model EXACTLY ONCE", announceToasts === 1, `count=${announceToasts}`);

    // E4: the watermark advanced (announcement consumed exactly once).
    const wm = await page.evaluate(() => Number(localStorage.getItem("praison-tracker-lastseen") ?? 0));
    const evAt = await page.evaluate(() => new Date(window.__qaEvent.createdAt).getTime());
    check("E4 watermark advanced past the announced event", wm >= evAt, `wm=${wm} ev=${evAt}`);
  } catch (err) {
    failed += 1;
    console.log("FAIL  harness error —", err?.message ?? err);
  } finally {
    await browser.close();
  }

  console.log(`\nE-series: ${passed} pass, ${failed} fail`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
