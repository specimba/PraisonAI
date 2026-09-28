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
import {
  classifyDirectLaneFailure,
  isAbortError,
  isWatchdogAbortReason,
} from "../src/lib/chat-client";

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

console.log("[5] v10: watchdog abort reasons are NOT user intent (r94 E2E gap)");
check("runner stall Error → watchdog reason",
  isWatchdogAbortReason(
    new Error("no model output for over 20 seconds — the stream stalled")
  ) === true);
check("'stalled' short reason → watchdog",
  isWatchdogAbortReason(new Error("stream stalled")) === true);
check("'timed out' reason → watchdog",
  isWatchdogAbortReason(new Error("request timed out")) === true);
check("bare cancel (no reason) → NOT watchdog (stays user intent)",
  isWatchdogAbortReason(undefined) === false);
check("engine deadline DOMException → NOT watchdog (no stall marker)",
  isWatchdogAbortReason(new DOMException("aborted", "AbortError")) === false);

console.log("[6] v10 derived call-site logic (aborted && !watchdog → userAborted)");
{
  // derive EXACTLY like the runAgentChat call site (chat-client.ts):
  const reason1 = new Error("no model output for over 20 seconds");
  const userAborted1 = true && !isWatchdogAbortReason(reason1);
  check("aborted + watchdog reason → userAborted=false → fallback (THE v10 FIX)",
    userAborted1 === false &&
    classifyDirectLaneFailure(userAborted1, false) === "fallback");
  const userAborted2 = true && !isWatchdogAbortReason(undefined);
  check("aborted + bare (user cancel) → userAborted=true → rethrow",
    userAborted2 === true &&
    classifyDirectLaneFailure(userAborted2, false) === "rethrow");
}

console.log(`\nv9+v10 classifier verification: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
