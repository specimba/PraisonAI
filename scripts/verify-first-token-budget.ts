// ─── r143: live verification of the r142 first-token budget raise ───────────
// Drives the REAL engine (runRelayedCustom, the exact code path both lanes
// use) against a local mock upstream:
//   Case 1 (the r142 fix, previously fatal): upstream accepts the request,
//     sends headers, then stays SILENT for 25s before the first SSE byte —
//     a big-context deep pass legitimately thinking. OLD budget (12s) killed
//     this with "upstream deadline: no first token within 12s". NEW budget
//     (60s) must let it COMPLETE.
//   Case 2 (the budget must still bound): upstream sends headers then never
//     speaks. Assert the engine reports "no first token within 60s" — proving
//     the new value is armed (we assert on the retry status event; the final
//     throw comes only after the 3x pre-stream retry, ~180s, which we don't
//     need to sit through).
// Run: bun scripts/verify-first-token-budget.ts   (bun executes TS natively)

import * as http from "node:http";
import { runRelayedCustom, type EngineBody, type EngineToolIO } from "../src/lib/agent-engine";
import { buildToolDefs } from "../src/lib/tools-defs";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** OpenAI-compatible SSE upstream: headers now, first byte after `silentMs`. */
function mockUpstream(port: number, silentMs: number, speak: boolean): Promise<void> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
      });
      if (!speak) return; // hold the headers, never send a byte
      setTimeout(() => {
        res.write('data: {"choices":[{"delta":{"content":"OK-slow-ttfb"}}]}\n\n');
        res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
        res.write("data: [DONE]\n\n");
        res.end();
        resolve();
      }, silentMs);
    });
    server.listen(port, "127.0.0.1", () => resolve());
    // keep server alive for the whole test; process exits when done
    (server as unknown as { unref?: () => void }).unref?.();
  });
}

async function runEngine(baseUrl: string) {
  const events: Record<string, unknown>[] = [];
  const body: EngineBody = {
    baseUrl,
    apiKey: "qa-not-needed",
    model: "qa-mock-model",
    messages: [{ role: "user", content: "Say OK." }],
    tools: [],
    maxTokens: 64,
  };
  const toolIO = {
    defs: buildToolDefs([]),
    execute: async () => ({ ok: false, content: "no tools in QA" }),
  } as unknown as EngineToolIO;
  const t0 = Date.now();
  let enginePromise: Promise<void> | null = null;
  const withTimeout = <T,>(p: Promise<T>, ms: number): Promise<T> =>
    Promise.race([p, sleep(ms).then(() => { throw new Error(`test timeout after ${ms}ms`); })]);
  enginePromise = withTimeout(
    runRelayedCustom(body, (evt) => events.push({ ...evt, _at: Date.now() - t0 }), new AbortController().signal, toolIO),
    100_000
  );
  return { events, enginePromise, t0 };
}

async function main() {
  console.log("Case 1: 25s-silent TTFB, then speaks (OLD 12s budget killed this)");
  await mockUpstream(8931, 25_000, true);
  const c1 = await runEngine("http://127.0.0.1:8931/v1");
  let case1ok = false;
  try {
    await c1.enginePromise;
    const done = c1.events.find((e) => e.type === "done") as { content?: string } | undefined;
    const elapsed = Math.round((Date.now() - c1.t0) / 1000);
    case1ok = !!done && String(done.content ?? "").includes("OK-slow-ttfb");
    console.log(`  engine completed in ~${elapsed}s · done content: ${JSON.stringify(done?.content ?? null).slice(0, 60)}`);
    console.log(case1ok ? "  ✅ CASE 1 PASS — slow-TTFB call survives (pre-r142: dead at ~12s)" : "  ❌ CASE 1 FAIL — completed but content missing");
  } catch (err) {
    const statuses = c1.events.filter((e) => e.type === "status").map((e) => String(e.message));
    console.log("  ❌ CASE 1 FAIL — engine errored:", (err as Error).message);
    console.log("  statuses:", statuses.slice(-3).join(" | "));
  }

  console.log("Case 2: silent forever — the budget must still fire at ~60s (not 12s)");
  await mockUpstream(8932, 0, false);
  const c2 = await runEngine("http://127.0.0.1:8932/v1");
  let case2ok = false;
  const deadlineEvent = await Promise.race([
    c2.enginePromise.then(() => null),
    (async () => {
      // poll the collected events for the budget-firing status line
      for (let i = 0; i < 120; i++) {
        await sleep(1000);
        const hit = c2.events.find(
          (e) => e.type === "status" && /no first token within (\d+)s/.test(String(e.message))
        );
        if (hit) {
          const sec = Number(String(hit.message).match(/no first token within (\d+)s/)?.[1]);
          return { at: Math.round((Date.now() - c2.t0) / 1000), sec };
        }
      }
      return null;
    })(),
  ]);
  if (deadlineEvent) {
    case2ok = deadlineEvent.sec === 60 && deadlineEvent.at >= 55 && deadlineEvent.at <= 70;
    console.log(`  budget fired at ~${deadlineEvent.at}s with value ${deadlineEvent.sec}s`);
    console.log(case2ok ? "  ✅ CASE 2 PASS — 60s budget armed (pre-r142: fired at ~12s)" : "  ❌ CASE 2 FAIL — wrong budget value/timing");
  } else {
    console.log("  ❌ CASE 2 FAIL — no deadline status within 120s");
  }

  console.log(case1ok && case2ok ? "\nVERDICT: r142 first-token fix verified against the live engine (2/2)" : "\nVERDICT: FAILED");
  process.exit(case1ok && case2ok ? 0 : 1);
}

main().catch((e) => {
  console.error("verify script crashed:", e);
  process.exit(2);
});
