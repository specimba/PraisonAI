#!/usr/bin/env node
// ─── r176 QA: chat settle/queue contract (F-series) ──────────────────────────
// Audit finding (chat-view.tsx, the largest unaudited surface): the queued
// follow-up ("async steering") auto-flushed on EVERY settle except "stopped" —
// including "error". During a congestion wave an errored turn immediately
// re-fired the queued message into the same failing gateway (a second attempt
// burned inside the same failure window — the exact r170 complaint). The fix:
// on "error" the queue is HELD (composer keeps the pending chip; "Send now"
// or the next successful turn flushes it).
// Also hardened: regenerate / editAndResend / answerAs now guard on the
// synchronous streamingRef (parity with send), closing the double-activation
// re-entry window into runTurn.
// Harness stages a chat through a fetch override that serves BOTH transports:
//   /api/chat        → relay SSE ({"type":"token"|"done"|"error"} frames)
//   any external url → OpenAI-style SSE (browser-direct path)
// Mode (success/error) flips via sessionStorage.__qaMode; every /api/chat or
// external hit is counted in window.__qaHits.
//   F1  errored turn + queued follow-up → queue HELD (1 hit, chip stays,
//       honest toast) — this auto-sent (2nd hit) before the fix
//   F2  successful turn + queued follow-up → auto-flush preserved (2 hits,
//       chip cleared)
//   F3  same-task double activation of Regenerate → exactly ONE new run
// Usage: node scripts/cdp-qa-chat-guard.mjs [baseUrl]

import { chromium } from "playwright";

const BASE = process.argv[2] ?? "http://localhost:3000";

let passed = 0;
let failed = 0;
function check(name, ok, detail = "") {
  if (ok) passed += 1;
  else failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const browser = await chromium.launch({
    executablePath:
      "/home/z/.cache/ms-playwright/chromium_headless_shell-1200/chrome-headless-shell-linux64/chrome-headless-shell",
    args: ["--no-sandbox"],
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 200)));

  const AGENT = {
    id: "qa-agent-1",
    name: "QA Bot",
    emoji: "🤖",
    role: "QA responder",
    description: "Harness fixture agent",
    instructions: "You are a QA fixture. Answer briefly.",
    model: "auto",
    temperature: 0.4,
    maxIterations: 3,
    tools: [],
  };
  const CONV_ID = "qa-conv-1";
  const CONV = {
    id: CONV_ID,
    title: "QA chat",
    agentId: AGENT.id,
    memory: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: [
      {
        id: "qa-msg-u0",
        role: "user",
        content: "seed hello",
        createdAt: Date.now() - 60_000,
        toolCalls: [],
        status: "done",
      },
    ],
  };

  await context.addInitScript(() => {
    if (!sessionStorage.getItem("__qa_seeded")) {
      sessionStorage.setItem("__qa_seeded", "1");
      sessionStorage.setItem("__qaMode", "error");
      localStorage.clear();
      localStorage.setItem(
        "praison-agents",
        JSON.stringify({
          state: {
            agents: [
              {
                id: "qa-agent-1",
                name: "QA Bot",
                emoji: "🤖",
                role: "QA responder",
                description: "Harness fixture agent",
                instructions: "You are a QA fixture. Answer briefly.",
                model: "auto",
                temperature: 0.4,
                maxIterations: 3,
                tools: [],
              },
            ],
          },
          version: 0,
        })
      );
      localStorage.setItem(
        "praison-conversations",
        JSON.stringify({
          state: {
            conversations: [
              {
                id: "qa-conv-1",
                title: "QA chat",
                agentId: "qa-agent-1",
                memory: null,
                createdAt: Date.now(),
                updatedAt: Date.now(),
                messages: [
                  {
                    id: "qa-msg-u0",
                    role: "user",
                    content: "seed hello",
                    createdAt: Date.now() - 60_000,
                    toolCalls: [],
                    status: "done",
                  },
                ],
              },
            ],
            activeId: "qa-conv-1",
          },
          version: 0,
        })
      );
      localStorage.setItem(
        "praison-settings",
        JSON.stringify({
          state: {
            settings: {
              relayEnabled: true,
              // vyce + aihubmix are ARENA_CATALOG members (observed live) —
              // non-empty keys make buildRelayChain yield hops → the client
              // picks the relay transport → ONE /api/chat fetch per run.
              providerKeys: { vyce: { key: "qa-key" }, aihubmix: { key: "qa-key" } },
            },
          },
          version: 0,
        })
      );
    }
    // Fresh per page load: hit ledger + transport-agnostic stub.
    window.__qaHits = [];
    const orig = window.fetch;
    window.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : (input?.url ?? "");
      const mode = sessionStorage.getItem("__qaMode") ?? "error";
      const isRelay = url.includes("/api/chat");
      const isExternal = /^https?:\/\//i.test(url) && !url.includes("localhost:3000");
      if (isRelay || isExternal) {
        window.__qaHits.push(url.slice(0, 80));
        await new Promise((r) => setTimeout(r, mode === "error" ? 120 : 1200));
        if (mode === "error") {
          return new Response(JSON.stringify({ error: "qa simulated failure" }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (isRelay) {
          const body =
            `data: ${JSON.stringify({ type: "token", text: "qa-ok" })}\n\n` +
            `data: ${JSON.stringify({ type: "done", content: "qa-ok", toolCalls: [], iterations: 1 })}\n\n`;
          return new Response(body, {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          });
        }
        const openai =
          `data: ${JSON.stringify({ choices: [{ delta: { content: "qa-ok" } }] })}\n\n` +
          `data: [DONE]\n\n`;
        return new Response(openai, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      return orig(input, init);
    };
  });

  await page.goto(BASE, { waitUntil: "domcontentloaded" });

  // Land on the chat surface if the shell opens elsewhere (tolerant).
  const box = page.getByRole("textbox", { name: /Message / });
  try {
    await box.waitFor({ timeout: 6000 });
  } catch {
    for (const sel of ['[role="tab"]', "nav button", "aside button", "button"]) {
      const el = page.locator(sel).filter({ hasText: /^chat$/i }).first();
      if (await el.count().catch(() => 0)) {
        await el.click({ timeout: 1500 }).catch(() => {});
        break;
      }
    }
    await box.waitFor({ timeout: 8000 });
  }

  const hits = () => page.evaluate(() => window.__qaHits.length);
  const chip = () => page.locator('[aria-label="Queued follow-up message"]').count();
  const sendText = async (text, expectBubble = true) => {
    await box.fill(text);
    await box.press("Enter");
    if (!expectBubble) return;
    try {
      await page.getByText(text).first().waitFor({ timeout: 2500 });
    } catch {
      // Enter didn't dispatch — fall back to the send button.
      const btn = page.getByRole("button", { name: /send/i }).first();
      if (await btn.count().catch(() => 0)) await btn.click().catch(() => {});
      await page.getByText(text).first().waitFor({ timeout: 3000 });
    }
  };

  // ── F1: errored turn + queued follow-up → queue HELD ──────────────────────
  await sendText("first");
  await sleep(300); // turn is streaming now (stub delays 400ms)
  console.log("[dbg] hits after send:", await hits());
  await sendText("second", false);
  const chipMid = await chip();
  check("F1a follow-up submitted while streaming is queued (chip shows)", chipMid === 1, `chip=${chipMid}`);
  // Settle signal: runTurn's catch toasts "The agent failed to respond".
  // Browser-direct rotation may sweep the whole free catalog before settling,
  // so give it a generous window.
  let settled1 = false;
  for (let i = 0; i < 55 && !settled1; i++) {
    const ts = await page.locator("[data-sonner-toast]").allTextContents().catch(() => []);
    settled1 = ts.some((t) => t.includes("failed to respond"));
    if (!settled1) await sleep(450);
  }
  if (!settled1) {
    const dbg = await page.evaluate(() => ({
      hits: window.__qaHits,
      toasts: [...document.querySelectorAll("[data-sonner-toast]")].map((t) => (t.textContent ?? "").slice(0, 90)),
      body: document.body.innerText.slice(0, 400),
    }));
    console.log("[dbg F1]", JSON.stringify(dbg, null, 1).slice(0, 1400));
    throw new Error("F1: the errored turn never settled (no failure toast)");
  }
  await sleep(700); // settle handler + toast window
  const H1 = await hits();
  const f1Chip = await chip();
  await sleep(2000); // an auto-flush would start a NEW rotation immediately
  const H2 = await hits();
  check("F1b errored turn does NOT auto-send the queue (hits stable post-settle)", H2 === H1, `hits ${H1}→${H2}`);
  check("F1c queue still pending after the error (chip retained)", f1Chip === 1, `chip=${f1Chip}`);
  let toastTxt = "";
  for (let i = 0; i < 20 && !toastTxt; i++) {
    toastTxt = await page
      .locator("[data-sonner-toast]")
      .allTextContents()
      .then((ts) => ts.join(" | "))
      .catch(() => "");
    if (!toastTxt.includes("still pending")) await sleep(200);
  }
  check(
    "F1d honest toast explains the held queue",
    toastTxt.includes("still pending"),
    toastTxt.slice(0, 120)
  );

  // ── F2: successful turn + queued follow-up → auto-flush preserved ─────────
  await page.evaluate(() => sessionStorage.setItem("__qaMode", "success"));
  await page.reload({ waitUntil: "domcontentloaded" });
  await box.waitFor({ timeout: 10000 });
  await sendText("first again");
  // Wait for the live streaming indicator before queueing — submitting into a
  // turn that already settled would send directly instead of queueing.
  await page.getByText("thinking…").first().waitFor({ timeout: 5000 }).catch(() => {});
  await sleep(150);
  await sendText("second", false);
  const chipMid2 = await chip();
  check("F2a follow-up queued while the success turn streams", chipMid2 === 1, `chip=${chipMid2}`);
  let f2Hits = 0;
  for (let i = 0; i < 30; i++) {
    f2Hits = await hits();
    if (f2Hits >= 2) break;
    await sleep(300);
  }
  check("F2b successful settle auto-flushes the queue (2 hits)", f2Hits === 2, `hits=${f2Hits}`);
  await sleep(1200);
  const f2Chip = await chip();
  check("F2c pending chip cleared after the flush", f2Chip === 0, `chip=${f2Chip}`);

  // ── F3: same-task double activation of Regenerate → ONE new run ───────────
  await page.getByRole("button", { name: /Regenerate response/i }).waitFor({ timeout: 6000 });
  const before = await hits();
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll("button")].find((b) =>
      /regenerate response/i.test(b.textContent ?? "")
    );
    btn?.click();
    btn?.click(); // same-task double activation — the pre-rerender race window
  });
  await sleep(1600);
  const after = await hits();
  check("F3 double-activated regenerate enters runTurn exactly once", after - before === 1, `delta=${after - before}`);

  await browser.close();
  console.log(`\n${passed}/${passed + failed} checks passed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("HARNESS ERROR:", e);
  process.exit(2);
});
