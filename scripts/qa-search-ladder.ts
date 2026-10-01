/**
 * r177 QA (K-series): transient-network retry ladder + run-report filename
 * versioning — the two user-reported fixes. Pure-logic, bun-run.
 *   K1  transient network error → one retry of the primary succeeds (raw result)
 *   K2  transient network error → retry fails → fallback ladder serves, labeled
 *       "unreachable (network error)"
 *   K3  rate-limit (429) path unchanged: no primary retry (attempts stay 1),
 *       fallback labeled "rate-limited (HTTP 429)"
 *   K4  non-transient error propagates untouched with NO retry, NO fallback
 *   K5  abort during the retry backoff → throws immediately (no second dial)
 *   K6  filename: ordinal + timestamp, no letter when minutes differ
 *   K7  filename: same-minute sibling runs get a/b letters (the user's ask)
 *   K8  filename: unknown run id falls back to last ordinal (never 000)
 * Usage: bun run scripts/qa-search-ladder.ts
 */
import { runSearchLadder, isTransientNetworkError } from "../src/lib/server/tools";
import { runReportFileName } from "../src/lib/helpers";

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) passed += 1;
  else failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // K1: network error → retry succeeds
  {
    let attempts = 0;
    const out = await runSearchLadder<string>(
      async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("Error: network error");
        return "primary-ok";
      },
      [{ id: "arxiv_search", run: async () => "should-not-run" }]
    );
    check("K1 network error retried once, primary recovered", out === "primary-ok" && attempts === 2, `attempts=${attempts}`);
  }

  // K2: network error → retry fails → fallback serves, honestly labeled
  {
    let attempts = 0;
    const out = await runSearchLadder<string>(
      async () => {
        attempts += 1;
        throw new Error("Failed to fetch");
      },
      [{ id: "arxiv_search", run: async () => "arxiv-served" }]
    );
    const ok =
      typeof out === "string" &&
      out.includes("unreachable (network error)") &&
      out.includes("auto-fell back to arxiv_search") &&
      out.includes("arxiv-served");
    check("K2 retry-then-fallback serves with honest label", ok && attempts === 2, `attempts=${attempts}`);
  }

  // K3: 429 path unchanged — no primary retry, straight to the ladder
  {
    let attempts = 0;
    const out = await runSearchLadder<string>(
      async () => {
        attempts += 1;
        throw new Error("Request failed with status code 429");
      },
      [{ id: "wikipedia_search", run: async () => "wiki-served" }]
    );
    const ok =
      typeof out === "string" &&
      out.includes("rate-limited (HTTP 429)") &&
      out.includes("auto-fell back to wikipedia_search");
    check("K3 429 ladder unchanged (no primary retry)", ok && attempts === 1, `attempts=${attempts}`);
  }

  // K4: non-transient error propagates untouched
  {
    let attempts = 0;
    let threw = "";
    try {
      await runSearchLadder<string>(
        async () => {
          attempts += 1;
          throw new Error("invalid api key");
        },
        [{ id: "arxiv_search", run: async () => "nope" }]
      );
    } catch (e) {
      threw = e instanceof Error ? e.message : String(e);
    }
    check("K4 non-transient propagates, no retry/fallback", threw === "invalid api key" && attempts === 1, `attempts=${attempts}`);
  }

  // K5: abort during the retry backoff → no second dial
  {
    const ctl = new AbortController();
    let attempts = 0;
    let threw = false;
    const p = runSearchLadder<string>(
      async () => {
        attempts += 1;
        throw new Error("socket hang up");
      },
      [],
      ctl.signal
    ).catch(() => {
      threw = true;
    });
    await sleep(50); // inside the 500-900ms backoff now
    ctl.abort();
    await p;
    check("K5 abort during backoff cancels the retry", threw && attempts === 1, `attempts=${attempts}`);
  }

  // K6/K7/K8: filename versioning
  {
    const t0 = new Date(2026, 9, 2, 1, 10).getTime(); // local 2026-10-02 01:10
    const runs = [
      { id: "r-old", startedAt: t0 - 3_600_000 },
      { id: "r-a", startedAt: t0 },
      { id: "r-b", startedAt: t0 + 20_000 }, // same minute as r-a
      { id: "r-next", startedAt: t0 + 3_600_000 },
    ];
    const nameA = runReportFileName("Continuous Research Evaluation & Opportunities", runs[1], runs);
    const nameB = runReportFileName("Continuous Research Evaluation & Opportunities", runs[2], runs);
    const nameNext = runReportFileName("Nightly Research", runs[3], runs);
    check(
      "K6 distinct-minute runs: ordinal+stamp, no letter",
      /^praison-run-nightly-research-run004-20261002-0210\.md$/.test(nameNext),
      nameNext
    );
    check(
      "K7 same-minute siblings get a/b letters",
      /run002-20261002-0110a\.md$/.test(nameA) && /run003-20261002-0110b\.md$/.test(nameB),
      `${nameA} | ${nameB}`
    );
    const ghost = runReportFileName("X", { id: "ghost", startedAt: t0 }, runs);
    check("K8 unknown run id → last ordinal, never 000/NaN", /run005-/.test(ghost), ghost);
    check(
      "K-pre isTransientNetworkError classifies honestly",
      isTransientNetworkError(new Error("Error: network error")) &&
        !isTransientNetworkError(new Error("web_search timed out after 15s")),
      "timeout deliberately excluded"
    );
  }

  console.log(`\n${passed}/${passed + failed} checks passed`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
