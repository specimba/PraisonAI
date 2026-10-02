// r190 QA — branch router for variation proposals (arXiv:2609.37834,
// "Mixture of Self-Improving Branches For Agent Harness Optimization"):
// least-used branch first (exploration), best-past-novelty among equals
// (exploitation), legacy hash pick as cold-start tie-break.
// Run: bun run scripts/qa-spawn-branches.ts

import {
  ANGLES,
  angleOfProposal,
  buildVariationProposal,
  maybeProposeSpawn,
  pickVariationAngle,
  NOVELTY_SPAWN_THRESHOLD,
  type AngleHistoryEntry,
} from "../src/lib/spawn-proposal-engine";
import * as fs from "node:fs";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => {
  console.log(`  ${c ? "✓" : "✗"} ${m}`);
  if (c) pass++; else fail++;
};
const src = fs.readFileSync("src/lib/spawn-proposal-engine.ts", "utf8");
const runnerSrc = fs.readFileSync("src/lib/workflow-runner.ts", "utf8");
const viewSrc = fs.readFileSync("src/components/praison/workflows/workflows-view.tsx", "utf8");

const TASK = "recursive self improvement for agentic automation systems";

console.log("B1 — cold start: empty history collapses to the legacy hash pick");
const legacyIdx = (() => {
  let h = 0;
  for (let i = 0; i < TASK.length; i++) h = (h * 31 + TASK.charCodeAt(i)) >>> 0;
  return h % ANGLES.length;
})();
ok(pickVariationAngle(TASK) === ANGLES[legacyIdx], "empty history === legacy hash angle (backward compatible)");
ok(pickVariationAngle(TASK) === pickVariationAngle(TASK), "deterministic for the same task");

console.log("B2 — exploration: never re-propose the same single trajectory");
const once: AngleHistoryEntry[] = [{ angle: ANGLES[0] }];
ok(pickVariationAngle(TASK, once) !== ANGLES[0], "after one proposal of branch 0, router picks a complementary branch");
const threeUsed: AngleHistoryEntry[] = [
  { angle: ANGLES[0] }, { angle: ANGLES[1] }, { angle: ANGLES[2] },
];
ok(pickVariationAngle(TASK, threeUsed) === ANGLES[3], "three branches used once → the untouched 4th is next (full coverage before any repeat)");

console.log("B3 — exploitation: best past novelty among equally-fresh branches wins");
const allOnce = [
  { angle: ANGLES[0], novelty: 10 },
  { angle: ANGLES[1], novelty: 90 },
  { angle: ANGLES[2], novelty: 50 },
  { angle: ANGLES[3], novelty: 50 },
];
ok(pickVariationAngle(TASK, allOnce) === ANGLES[1], "all branches used → highest-avg-novelty branch (90%) selected");
const weakBest = [
  { angle: ANGLES[0], novelty: 90, },
  { angle: ANGLES[0], novelty: 10 },
  { angle: ANGLES[1], novelty: 55 },
  { angle: ANGLES[2], novelty: 55 },
  { angle: ANGLES[3], novelty: 55 },
];
ok(pickVariationAngle(TASK, weakBest) === ANGLES[1], "avg novelty: overused branch 0 (avg 50) excluded by least-used rule; 55-branches tie → stable ANGLES order picks branch 1");
const freshBeatsOld = [
  { angle: ANGLES[0], novelty: 95 },
  { angle: ANGLES[1], novelty: 5 },
];
ok(pickVariationAngle(TASK, freshBeatsOld) !== ANGLES[0] && pickVariationAngle(TASK, freshBeatsOld) !== ANGLES[1], "used-once branches lose to untouched ones regardless of past novelty");

console.log("B4 — history hygiene");
ok(pickVariationAngle(TASK, [{ angle: "garbage angle text" }, { angle: "" }]) === ANGLES[legacyIdx], "unknown/legacy angle strings are ignored");
ok(ANGLES.every((a) => angleOfProposal(`do X — approach it from ${a}`) === a), "angleOfProposal round-trips every branch");
ok(angleOfProposal("a goal with no embedded angle") === null, "angleless goal → null (ignored by the router)");
ok(pickVariationAngle(TASK, [{ angle: ANGLES[2], novelty: 1 }, { angle: ANGLES[2] }]) !== ANGLES[2], "novelty attaches to the right branch even mixed with unscored uses");

console.log("B5 — proposal builder: rotation is visible, cold start unchanged");
const stalled = buildVariationProposal({
  sourceWorkflowId: "wf-1",
  sourceWorkflowName: "RSIinFIELD",
  sourceRunId: "run-1",
  taskExcerpt: TASK,
  novelty: 22,
});
ok(stalled.goal.endsWith(`approach it from ${ANGLES[legacyIdx]}`), "no history → goal matches legacy angle");
ok(!stalled.reason.includes("branch rotated"), "no history → no rotation note");
const rotated = buildVariationProposal({
  sourceWorkflowId: "wf-1",
  sourceWorkflowName: "RSIinFIELD",
  sourceRunId: "run-2",
  taskExcerpt: TASK,
  novelty: 22,
  angleHistory: [{ angle: ANGLES[legacyIdx] }, { angle: ANGLES[legacyIdx] }],
});
ok(ANGLES.some((a) => rotated.goal.endsWith(`approach it from ${a}`)), "rotated goal still names a valid branch");
ok(rotated.goal !== stalled.goal, "two uses of the legacy branch force a DIFFERENT goal angle");
ok(rotated.reason.includes("branch rotated after 2 prior proposals"), "rotation note carries the prior-proposal count");

console.log("B6 — maybeProposeSpawn: gates intact, history flows through");
ok(maybeProposeSpawn({
  status: "error", novelty: 10, openSourceIds: [], sourceWorkflowId: "wf-1",
  sourceWorkflowName: "x", sourceRunId: "r", taskExcerpt: TASK,
}) === null, "non-done runs never spawn");
ok(maybeProposeSpawn({
  status: "done", novelty: NOVELTY_SPAWN_THRESHOLD + 5, openSourceIds: [], sourceWorkflowId: "wf-1",
  sourceWorkflowName: "x", sourceRunId: "r", taskExcerpt: TASK,
}) === null, "healthy novelty never spawns");
ok(maybeProposeSpawn({
  status: "done", novelty: 10, openSourceIds: ["wf-1"], sourceWorkflowId: "wf-1",
  sourceWorkflowName: "x", sourceRunId: "r", taskExcerpt: TASK,
}) === null, "open-proposal anti-spam cap intact");
const spawned = maybeProposeSpawn({
  status: "done", novelty: 10, openSourceIds: ["wf-other"], sourceWorkflowId: "wf-1",
  sourceWorkflowName: "RSIinFIELD", sourceRunId: "r", taskExcerpt: TASK,
  angleHistory: [{ angle: ANGLES[legacyIdx] }, { angle: ANGLES[legacyIdx] }],
});
ok(spawned != null && spawned.goal !== stalled.goal, "qualifying stall + history → routed proposal (not the hashed repeat)");

console.log("B7 — source wiring: both call sites feed the router");
ok(/angleOfProposal/.test(runnerSrc) && /angleHistory/.test(runnerSrc), "workflow-runner derives angle history from the proposals store");
ok(/angleOfProposal/.test(viewSrc) && /angleHistory/.test(viewSrc), "manual 'Suggest variation' feeds the router too");
ok(/pickVariationAngle\(base, input\.angleHistory\)/.test(src), "builder routes through pickVariationAngle (single decision point)");
ok(!/hashPick/.test(src), "legacy hashPick name is gone (replaced by index tie-break)");

console.log(`\nB-series (branch router): ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
