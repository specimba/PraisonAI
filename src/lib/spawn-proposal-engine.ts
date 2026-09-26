import type { SpawnProposal } from "@/lib/types";

/**
 * Evolution spawn-proposal engine — pure decision logic (no store imports)
 * so it stays unit-testable. The workflow runner applies it best-effort in
 * finish(); a proposal must NEVER affect run finalization.
 */

/** Below this novelty % a finished run counts as a near-duplicate output. */
export const NOVELTY_SPAWN_THRESHOLD = 35;

const ANGLES = [
  "a sharper, more focused angle on the highest-value part",
  "an opposing viewpoint that stress-tests the conclusion",
  "a deeper technical dive with concrete data and examples",
  "a practical, execution-oriented angle with step-by-step actions",
];

/** Deterministic tiny hash — the same task always picks the same angle. */
const hashPick = (text: string): string => {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
  return ANGLES[h % ANGLES.length];
};

export interface MaybeProposeSpawnInput {
  status: "done" | "error" | "stopped";
  novelty?: number;
  /** workflowIds that already have an open proposal (anti-spam cap). */
  openSourceIds: string[];
  sourceWorkflowId: string;
  sourceWorkflowName: string;
  sourceRunId: string;
  taskExcerpt: string;
}

/**
 * Should a finished run spawn an Evolution proposal?
 * Returns null when the run does not qualify: not "done", novelty healthy,
 * or an open proposal for this source workflow already exists.
 */
export function maybeProposeSpawn(
  input: MaybeProposeSpawnInput
): SpawnProposal | null {
  if (input.status !== "done") return null;
  if (input.novelty == null || input.novelty >= NOVELTY_SPAWN_THRESHOLD)
    return null;
  if (input.openSourceIds.includes(input.sourceWorkflowId)) return null;
  const base =
    input.taskExcerpt.trim().replace(/\s+/g, " ").slice(0, 220) ||
    input.sourceWorkflowName;
  return {
    goal: `${base} — approach it from ${hashPick(base)}`,
    reason: `Novelty stalled at ${Math.round(input.novelty)}% — recent runs of this pipeline produce near-duplicate output, so a fresh angle is proposed`,
    sourceWorkflowId: input.sourceWorkflowId,
    sourceWorkflowName: input.sourceWorkflowName,
    sourceRunId: input.sourceRunId,
  };
}
