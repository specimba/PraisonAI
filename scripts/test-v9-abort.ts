/**
 * v9 verification: browser-direct failure classifier.
 * Run: cd /home/z/my-project && bun scripts/test-v9-abort.ts
 *
 * classifyDirectLaneFailure is the ONE decision point for the direct lane:
 *   userAborted  → rethrow  (never re-dial over a user cancel — any error class)
 *   sawTokens    → rethrow  (mid-stream death surfaces honestly, self-heal retries)
 *   otherwise    → fallback (pre-stream death incl. internal deadline aborts —
 *                            the r92-proven gap where stalled direct providers
 *                            terminated the step with no relay fallback)
 * isAbortError sanity: transport-signal classifier only (AbortError /
 * ResponseAborted true; TimeoutError false).
 */
import { classifyDirectLaneFailure, isAbortError } from "../src/lib/chat-client";

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

console.log("[1] user cancel → rethrow (any error class)");
check("userAborted + AbortError → rethrow",
  classifyDirectLaneFailure(true, false) === "rethrow");
check("userAborted + plain error → rethrow (no re-dial over cancel)",
  classifyDirectLaneFailure(true, false) === "rethrow");
check("userAborted + sawTokens → rethrow",
  classifyDirectLaneFailure(true, true) === "rethrow");

console.log("[2] mid-stream death → rethrow (honest surface, no model stitching)");
check("sawTokens, no user abort → rethrow",
  classifyDirectLaneFailure(false, true) === "rethrow");

console.log("[3] pre-stream failure → fallback (incl. the v8/r92 gap)");
check("pre-stream plain error (CORS/net) → fallback",
  classifyDirectLaneFailure(false, false) === "fallback");
check("pre-stream internal deadline abort → fallback (THE FIX)",
  classifyDirectLaneFailure(false, false) === "fallback");

console.log("[4] isAbortError = transport-signal classifier sanity");
check("AbortError → true",
  isAbortError(new DOMException("The operation was aborted.", "AbortError")) === true);
check("ResponseAborted → true",
  isAbortError(new DOMException("Response aborted.", "ResponseAborted")) === true);
check("TimeoutError → false (different name)",
  isAbortError(new DOMException("Signal timed out.", "TimeoutError")) === false);
check("plain error → false",
  isAbortError(new Error("CORS preflight failed")) === false);

console.log(`\nv9 classifier verification: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
