/** Unit check for the pure spawn-proposal engine (bun run). */
import {
  maybeProposeSpawn,
  NOVELTY_SPAWN_THRESHOLD,
} from "../src/lib/spawn-proposal-engine";

let failures = 0;
const check = (name: string, cond: boolean) => {
  console.log(`${cond ? "PASS" : "FAIL"} — ${name}`);
  if (!cond) failures++;
};

const base = {
  status: "done" as const,
  novelty: 20,
  openSourceIds: [] as string[],
  sourceWorkflowId: "wf-src",
  sourceWorkflowName: "RSIinFIELD",
  sourceRunId: "run-1",
  taskExcerpt: "Analyze RSI signals and draft a field report",
};

// 1. Low-novelty done run → proposal with structured goal/reason
const p = maybeProposeSpawn(base);
check("low novelty (<35) done run yields a proposal", p !== null);
check(
  "goal embeds the task excerpt + angle suffix",
  !!p && p.goal.startsWith(base.taskExcerpt) && p.goal.includes("approach it from"),
);
check(
  "reason mentions the numeric novelty score",
  !!p && /Novelty stalled at 20%/.test(p.reason),
);
check(
  "source fields carried through",
  !!p && p.sourceWorkflowId === "wf-src" && p.sourceWorkflowName === "RSIinFIELD" && p.sourceRunId === "run-1",
);

// 2. Healthy novelty → null
check(
  "novelty >= threshold yields null",
  maybeProposeSpawn({ ...base, novelty: NOVELTY_SPAWN_THRESHOLD }) === null &&
    maybeProposeSpawn({ ...base, novelty: 80 }) === null,
);

// 3. Not a done run → null (errors/stopped never propose)
check(
  "error/stopped runs yield null",
  maybeProposeSpawn({ ...base, status: "error" }) === null &&
    maybeProposeSpawn({ ...base, status: "stopped" }) === null,
);

// 4. Anti-spam cap: an open proposal for this source already exists → null
check(
  "duplicate open source id yields null",
  maybeProposeSpawn({ ...base, openSourceIds: ["other", "wf-src"] }) === null,
);
check(
  "open proposal for a DIFFERENT source still yields a proposal",
  maybeProposeSpawn({ ...base, openSourceIds: ["other"] }) !== null,
);

// 5. Determinism + long-input clamp
const a = maybeProposeSpawn(base);
const b = maybeProposeSpawn(base);
check("deterministic angle pick (same input → same goal)", !!a && !!b && a!.goal === b!.goal);
const long = "x".repeat(500);
const clamped = maybeProposeSpawn({ ...base, taskExcerpt: long });
// Contract: the EXCERPT is clamped to 220 chars; the bounded angle suffix
// (" — approach it from " + longest angle) adds at most ~76 chars.
check(
  "long task excerpt clamped to 220 chars before the angle suffix",
  !!clamped && clamped.goal.length <= 220 + 76 && clamped.goal.length > 220,
);

// 6. Missing novelty → null (cannot judge)
check("undefined novelty yields null", maybeProposeSpawn({ ...base, novelty: undefined }) === null);

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
