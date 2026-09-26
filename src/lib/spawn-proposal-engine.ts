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
  return buildVariationProposal({
    sourceWorkflowId: input.sourceWorkflowId,
    sourceWorkflowName: input.sourceWorkflowName,
    sourceRunId: input.sourceRunId,
    taskExcerpt: input.taskExcerpt,
    novelty: input.novelty,
  });
}

export interface BuildVariationProposalInput {
  sourceWorkflowId: string;
  sourceWorkflowName: string;
  sourceRunId?: string;
  taskExcerpt: string;
  /** Latest run's novelty %, when known (drives the reason text). */
  novelty?: number;
  /** True when the USER requested this variation from a ledger row. */
  manual?: boolean;
}

/**
 * Construct a SpawnProposal — shared by the automatic runner generator
 * (maybeProposeSpawn) and the manual "Suggest variation" ledger action.
 */
export function buildVariationProposal(
  input: BuildVariationProposalInput
): SpawnProposal {
  const base =
    input.taskExcerpt.trim().replace(/\s+/g, " ").slice(0, 220) ||
    input.sourceWorkflowName;
  return {
    goal: `${base} — approach it from ${hashPick(base)}`,
    reason: input.manual
      ? input.novelty != null
        ? `Manually requested — latest run scored ${Math.round(input.novelty)}% novelty (below the ${NOVELTY_SPAWN_THRESHOLD}% stall threshold)`
        : "Manually requested variation — the user asked Evolution for a fresh angle"
      : `Novelty stalled at ${Math.round(input.novelty ?? 0)}% — recent runs of this pipeline produce near-duplicate output, so a fresh angle is proposed`,
    sourceWorkflowId: input.sourceWorkflowId,
    sourceWorkflowName: input.sourceWorkflowName,
    sourceRunId: input.sourceRunId,
  };
}
