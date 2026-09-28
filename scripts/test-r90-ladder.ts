/**
 * r90 verification: web_search 429 auto-fallback ladder.
 * Run: cd /home/z/my-project && bun scripts/test-r90-ladder.ts
 *
 * Deterministic where it matters, real where it counts:
 *  - isRateLimitError: pure unit matrix (429 / rate-limited / Too Many
 *    Requests hit; timeout / 5xx / 1429 do NOT).
 *  - runSearchLadder: primary STUBBED to throw the production storm shape
 *    (synthetic 429); fallbacks injected as stubs for ladder-order cases,
 *    then ONE case with the REAL arxiv_search executor via executeTool —
 *    a pass means real arXiv data flows through the ladder end-to-end.
 *  - Non-rate-limit errors must propagate untouched (no fallback attempt).
 */
import { isRateLimitError, runSearchLadder, executeTool } from "../src/lib/server/tools";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    pass++;
    console.log(`  PASS ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ─── 1. isRateLimitError matrix ──────────────────────────────────────────────
console.log("[1] isRateLimitError matrix");
check("429 status → true", isRateLimitError(new Error("Request failed with status code 429")) === true);
check("rate limited → true", isRateLimitError(new Error("web_search rate limited — slow down")) === true);
check("ratelimited (no sep) → true", isRateLimitError(new Error("Request failed: ratelimited")) === true);
check("Too Many Requests → true", isRateLimitError(new Error("HTTP/1.1 429 Too Many Requests")) === true);
check("timeout → false", isRateLimitError(new Error("web_search timed out after 15s")) === false);
check("5xx → false", isRateLimitError(new Error("arXiv API HTTP 503")) === false);
check("1429 (word-boundary) → false", isRateLimitError(new Error("status 1429")) === false);
check("plain error → false", isRateLimitError(new Error("boom")) === false);

// ─── 2. runSearchLadder: primary OK → untouched passthrough ─────────────────
console.log("[2] primary OK → passthrough, fallbacks never called");
{
  let fbCalls = 0;
  const out = await runSearchLadder(
    async () => [{ name: "primary result" }],
    [{ id: "arxiv_search", run: async () => { fbCalls++; return "SHOULD NOT APPEAR"; } }],
  );
  check("primary value returned", Array.isArray(out) && out[0]?.name === "primary result");
  check("fallback not invoked", fbCalls === 0);
}

// ─── 3. 429 → first fallback wins, labeled ──────────────────────────────────
console.log("[3] 429 → arxiv fallback labeled");
{
  const out = await runSearchLadder(
    async () => { throw new Error("Request failed with status code 429"); },
    [
      { id: "arxiv_search", run: async () => "ARXIV-CONTENT" },
      { id: "wikipedia_search", run: async () => "WIKI-CONTENT" },
    ],
  );
  const s = String(out);
  check("labeled with source", s.startsWith("[web_search rate-limited (HTTP 429) — auto-fell back to arxiv_search]"), s.slice(0, 80));
  check("first fallback content served", s.includes("ARXIV-CONTENT"));
  check("second fallback skipped", !s.includes("WIKI-CONTENT"));
}

// ─── 4. 429 → first fallback fails → second wins ────────────────────────────
console.log("[4] 429 → arxiv fails → wikipedia labeled");
{
  const out = await runSearchLadder(
    async () => { throw new Error("Too Many Requests"); },
    [
      { id: "arxiv_search", run: async () => { throw new Error("arXiv API HTTP 503"); } },
      { id: "wikipedia_search", run: async () => "WIKI-CONTENT" },
    ],
  );
  const s = String(out);
  check("second fallback label", s.startsWith("[web_search rate-limited (HTTP 429) — auto-fell back to wikipedia_search]"), s.slice(0, 90));
  check("second fallback content served", s.includes("WIKI-CONTENT"));
}

// ─── 5. 429 → all fallbacks fail → enriched error ───────────────────────────
console.log("[5] 429 + exhausted ladder → enriched error");
{
  try {
    await runSearchLadder(
      async () => { throw new Error("Request failed with status code 429"); },
      [
        { id: "arxiv_search", run: async () => { throw new Error("arXiv API HTTP 503"); } },
        { id: "wikipedia_search", run: async () => { throw new Error("wikipedia timed out after 15s"); } },
      ],
    );
    check("rejects when ladder exhausted", false, "expected throw, got resolution");
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    check("original cause preserved", m.includes("Request failed with status code 429"), m);
    check("exhaustion marker", m.includes("fallback ladder exhausted"), m);
    check("per-fallback notes", m.includes("arxiv_search: arXiv API HTTP 503") && m.includes("wikipedia_search: wikipedia timed out after 15s"), m);
  }
}

// ─── 6. non-rate-limit errors propagate UNTOUCHED (no fallback attempt) ─────
console.log("[6] 500 → propagates, ladder never fires");
{
  let fbCalls = 0;
  try {
    await runSearchLadder(
      async () => { throw new Error("web_search timed out after 15s"); },
      [{ id: "arxiv_search", run: async () => { fbCalls++; return "SHOULD NOT APPEAR"; } }],
    );
    check("timeout rejects", false, "expected throw, got resolution");
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    check("timeout propagated as-is", m === "web_search timed out after 15s", m);
    check("fallback not invoked on timeout", fbCalls === 0);
  }
}

// ─── 7. REAL end-to-end: stubbed 429 primary + REAL arxiv executor ──────────
console.log("[7] real arxiv_search through the ladder");
{
  const out = await runSearchLadder(
    async () => { throw new Error("Request failed with status code 429"); },
    [
      {
        id: "arxiv_search",
        run: async () => {
          const r = await executeTool("arxiv_search", JSON.stringify({ query: "multi-agent LLM systems", num: 3 }));
          if (!r.ok) throw new Error(r.content);
          return r.content;
        },
      },
    ],
  );
  const s = String(out);
  check("labeled real-arxiv result", s.startsWith("[web_search rate-limited (HTTP 429) — auto-fell back to arxiv_search]"), s.slice(0, 90));
  check("real arXiv data present (arxiv.org link)", s.includes("arxiv.org/abs/") || s.includes("arXiv:"), s.slice(0, 200));
}

console.log(`\nr90 ladder verification: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
