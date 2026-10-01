#!/usr/bin/env node
// ─── r163 QA: test playground error honesty (W-series) ──────────────────────
// The playground previously dropped the engine's structured error kind and
// dead-ended on failure (composer cleared, no retry). Now an errored turn
// renders a kind chip (amber for rate-limit) + one-click Retry. The SSE →
// throw-with-kind path itself is live-proven (r161 P1); the W-series mocks
// ONLY the wire at the browser level — chat-client's real parser and the
// real dialog logic run on top of it.
//   W1  SSE error kind=rate-limit → red message + amber "rate-limit" chip
//       + Retry button (aria "Retry this message").
//   W2  Retry after re-routing to a success stream → turn completes, chip
//       and button gone, still exactly ONE user bubble (no duplication).
//   W3  A fresh send against kind=network → neutral chip (amber is
//       rate-limit-specific, not a blanket error style).
// Usage: node scripts/cdp-qa-test-playground.mjs [baseUrl]

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
  id: "agent_play", name: "Playground Probe", emoji: "🧪", color: "cyan",
  role: "tester", description: "", instructions: "", model: "auto",
  temperature: 0.7, maxIterations: 1, tools: [], createdAt: NOW, updatedAt: NOW,
};

const sse = (frames) =>
  frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("");

const ERROR_STREAM = (kind, msg) =>
  sse([
    { type: "start" },
    { type: "error", message: msg, kind },
  ]);
const OK_STREAM = sse([
  { type: "start" },
  { type: "token", text: "Recovered fine." },
  { type: "done", content: "Recovered fine.", toolCalls: [], iterations: 1 },
]);

async function main() {
  const browser = await chromium.launch({
    executablePath:
      "/home/z/.cache/ms-playwright/chromium_headless_shell-1200/chrome-headless-shell-linux64/chrome-headless-shell",
    args: ["--no-sandbox"],
  });
  const context = await browser.newContext();
  const page = await context.newPage();

  const dialCount = { n: 0 };
  let mode = "error-rate-limit";
  page.on("console", (m) => {
    const t = m.type();
    if (t === "error" || t === "warning") console.log(`[page:${t}]`, m.text().slice(0, 200));
  });
  page.on("pageerror", async (e) => {
    console.log("[pageerror]", (e.stack || String(e)).slice(0, 400));
    try {
      const raw = await page.evaluate(() => localStorage.getItem("praison-agents"));
      console.log("[diag] praison-agents raw:", (raw ?? "(null)")?.slice(0, 500));
    } catch {}
  });

  try {
    // Seed one agent (fresh QA profile) before app code runs.
    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" }).catch(() => {});
    await page.evaluate((agents) => {
      localStorage.setItem("praison-agents", JSON.stringify({ state: { agents }, version: 1 }));
      // Force the "auto" (server relay) lane: the default settings ride the
      // pre-seeded Groq key on the BROWSER-DIRECT lane, which never touches
      // /api/chat. With provider="auto", resolveLlm → runServerAgent → the
      // intercepted POST. (Same kind contract on both lanes — the dialog
      // logic under test is transport-agnostic.)
      localStorage.setItem(
        "praison-settings",
        JSON.stringify({ state: { settings: { provider: "auto" } }, version: 0 })
      );
    }, [AGENT]);

    // Wire mock — the ONLY mocked layer (parser + dialog logic are real).
    await page.route(/\/api\/chat$/, async (route) => {
      dialCount.n += 1;
      const body =
        mode === "error-rate-limit"
          ? ERROR_STREAM("rate-limit", "Rate limit exceeded: gateway saturated (probe)")
          : mode === "error-network"
            ? ERROR_STREAM("network", "Could not reach the LLM provider (probe)")
            : OK_STREAM;
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream; charset=utf-8",
        headers: { "Cache-Control": "no-cache" },
        body,
      });
    });

    // Navigate to Agents, open the playground via the agent card.
    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
    const nav = page.getByRole("button", { name: /^Agents/ }).first();
    await nav.waitFor({ timeout: 20000 });
    await nav.dispatchEvent("pointerdown", { button: 0 });
    await nav.dispatchEvent("pointerup", { button: 0 });
    await nav.click();
    const card = page.locator('[role="button"]', { hasText: "Playground Probe" }).first();
    await card.waitFor({ timeout: 20000 });
    await card.dispatchEvent("pointerdown", { button: 0 });
    await card.dispatchEvent("pointerup", { button: 0 });
    await card.click();
    await page.getByRole("textbox", { name: "Test message" }).waitFor({ timeout: 20000 });

    // ── W1: rate-limit error → honest chip + retry ─────────────────────────
    await page.getByRole("textbox", { name: "Test message" }).fill("probe turn");
    await page.getByRole("button", { name: "Send message" }).click();
    await page.waitForTimeout(3000);
    const redTexts = await page.locator("p.text-red-500").allTextContents();
    const bubbles = await page.locator("div.ml-auto.max-w-\\[80\\%\\]").count();
    const taVal = await page.getByRole("textbox", { name: "Test message" }).inputValue();
    const stopVisible = await page.getByRole("button", { name: "Stop run" }).isVisible().catch(() => false);
    console.log(`[diag] userBubbles=${bubbles} taVal="${taVal}" running=${stopVisible} red=${JSON.stringify(redTexts)} dials=${dialCount.n}`);
    const dialogText = await page.locator("[role=\"dialog\"]").textContent();
    console.log(`[diag] dialog text: ${dialogText?.slice(0, 400)}`);
    await page.locator("text=Rate limit exceeded: gateway saturated (probe)").waitFor({ timeout: 15000 });
    check("W1a error message rendered", true, "rate-limit prose visible");
    const chip = page.locator('span[title*="shared gateway is congested"]').first();
    await chip.waitFor({ timeout: 10000 });
    const chipText = (await chip.textContent()) ?? "";
    const chipClass = (await chip.getAttribute("class")) ?? "";
    check(
      "W1b amber rate-limit kind chip",
      chipText.trim() === "rate-limit" && /amber/.test(chipClass),
      `text="${chipText.trim()}"`
    );
    const retryBtn = page.getByRole("button", { name: "Retry this message" });
    check("W1c Retry button offered", await retryBtn.isVisible(), `dials so far: ${dialCount.n}`);
    await page.screenshot({ path: "ops/qa/W-test-playground-error.png" });

    // ── W2: retry over a recovered wire → completes, one user bubble ──────
    mode = "ok";
    await retryBtn.click();
    await page.locator("text=Recovered fine.").waitFor({ timeout: 15000 });
    check("W2a retry completes on recovered stream", true, `dials: ${dialCount.n}`);
    check(
      "W2b no retry button on a done turn",
      !(await retryBtn.isVisible().catch(() => false)),
      ""
    );
    const userBubbles = await page.locator("div.bg-primary", { hasText: "probe turn" }).count();
    check("W2c user message NOT duplicated", userBubbles === 1, `count=${userBubbles}`);

    // ── W3: a different kind renders the NEUTRAL chip ──────────────────────
    mode = "error-network";
    await page.getByRole("textbox", { name: "Test message" }).fill("second probe");
    await page.getByRole("button", { name: "Send message" }).click();
    const neutralChip = page.locator('span[title*="Upstream error kind reported by the engine"]').first();
    await neutralChip.waitFor({ timeout: 15000 });
    const neutralText = (await neutralChip.textContent()) ?? "";
    const neutralClass = (await neutralChip.getAttribute("class")) ?? "";
    check(
      "W3 network kind → neutral (non-amber) chip",
      neutralText.trim() === "network" && !/amber/.test(neutralClass),
      `text="${neutralText.trim()}"`
    );
  } catch (e) {
    console.log(`[diag] dials fired: ${dialCount.n}, wire mode: ${mode}`);
    throw e;
  } finally {
    await browser.close().catch(() => {});
  }

  console.log(`\nW-series: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error("HARNESS ERROR:", e);
  process.exit(1);
});
