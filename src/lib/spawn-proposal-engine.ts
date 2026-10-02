import type { SpawnProposal } from "@/lib/types";

/**
 * Evolution spawn-proposal engine — pure decision logic (no store imports)
 * so it stays unit-testable. The workflow runner applies it best-effort in
 * finish(); a proposal must NEVER affect run finalization.
 */

/** Below this novelty % a finished run counts as a near-duplicate output. */
export const NOVELTY_SPAWN_THRESHOLD = 35;

/** The four variation branches. Exported for QA — the router's whole world. */
export const ANGLES = [
  "a sharper, more focused angle on the highest-value part",
  "an opposing viewpoint that stress-tests the conclusion",
  "a deeper technical dive with concrete data and examples",
  "a practical, execution-oriented angle with step-by-step actions",
];

/** Deterministic tiny hash — the same task always picks the same index. */
const hashIndex = (text: string): number => {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
  return h;
};

/** One past proposal's branch (angle) for the same source workflow, plus the
 * novelty of the run that followed it when the ledger has scored it. */
export interface AngleHistoryEntry {
  angle: string;
  novelty?: number;
}

/** Recover the branch a past proposal used — goals embed the angle text. */
export function angleOfProposal(goal: string): string | null {
  return ANGLES.find((a) => goal.includes(a)) ?? null;
}

const avg = (xs: number[] | undefined): number =>
  xs && xs.length > 0 ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;

/**
 * Branch router for variation proposals (arXiv:2609.37834, "Mixture of
 * Self-Improving Branches"): a fixed proposal policy channels evolution
 * along a single trajectory and converges to a local optimum — exactly what
 * the old code did, hashing the SAME angle out of the same task forever, so
 * a stalled pipeline kept receiving near-identical "fresh angles". Instead:
 * treat the four angles as branches, prefer the LEAST-USED branch for this
 * source (exploration — every branch gets tried before any repeats), and
 * among equally-fresh branches prefer the one whose past variation runs
 * scored best (exploitation — evolving objectives from search history).
 * Empty history collapses to the legacy hash pick, so old behavior survives
 * as the cold-start tie-break.
 */
export function pickVariationAngle(taskExcerpt: string, history: AngleHistoryEntry[] = []): string {
  const usage = new Map<string, number>(ANGLES.map((a) => [a, 0]));
  const noveltySamples = new Map<string, number[]>();
  for (const h of history) {
    if (!usage.has(h.angle)) continue; // unknown/legacy goal text — ignore
    usage.set(h.angle, (usage.get(h.angle) ?? 0) + 1);
    if (h.novelty != null) {
      const arr = noveltySamples.get(h.angle) ?? [];
      arr.push(h.novelty);
      noveltySamples.set(h.angle, arr);
    }
  }
  const minUse = Math.min(...ANGLES.map((a) => usage.get(a) ?? 0));
  const candidates = ANGLES.filter((a) => (usage.get(a) ?? 0) === minUse);
  if (candidates.length > 1) {
    const scored = candidates.filter((a) => (noveltySamples.get(a)?.length ?? 0) > 0);
    if (scored.length > 0) {
      scored.sort((a, b) => avg(noveltySamples.get(b)) - avg(noveltySamples.get(a)));
      return scored[0];
    }
  }
  return candidates[hashIndex(taskExcerpt) % candidates.length];
}

export interface MaybeProposeSpawnInput {
  status: "done" | "error" | "stopped";
  novelty?: number;
  /** Stall threshold override (Settings → Evolution). Missing = NOVELTY_SPAWN_THRESHOLD. */
  threshold?: number;
  /** workflowIds that already have an open proposal (anti-spam cap). */
  openSourceIds: string[];
  sourceWorkflowId: string;
  sourceWorkflowName: string;
  sourceRunId: string;
  taskExcerpt: string;
  /** r190: past proposals for this source — feeds the branch router. */
  angleHistory?: AngleHistoryEntry[];
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
  const threshold = input.threshold ?? NOVELTY_SPAWN_THRESHOLD;
  if (input.novelty == null || input.novelty >= threshold) return null;
  if (input.openSourceIds.includes(input.sourceWorkflowId)) return null;
  return buildVariationProposal({
    sourceWorkflowId: input.sourceWorkflowId,
    sourceWorkflowName: input.sourceWorkflowName,
    sourceRunId: input.sourceRunId,
    taskExcerpt: input.taskExcerpt,
    novelty: input.novelty,
    threshold: input.threshold,
    angleHistory: input.angleHistory,
  });
}

export interface BuildVariationProposalInput {
  sourceWorkflowId: string;
  sourceWorkflowName: string;
  sourceRunId?: string;
  taskExcerpt: string;
  /** Latest run's novelty %, when known (drives the reason text). */
  novelty?: number;
  /** Stall threshold override (Settings → Evolution). Missing = NOVELTY_SPAWN_THRESHOLD. */
  threshold?: number;
  /** True when the USER requested this variation from a ledger row. */
  manual?: boolean;
  /** r190: past proposals for this source — the branch router's history. */
  angleHistory?: AngleHistoryEntry[];
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
  const threshold = input.threshold ?? NOVELTY_SPAWN_THRESHOLD;
  const angle = pickVariationAngle(base, input.angleHistory);
  const prior = input.angleHistory?.length ?? 0;
  const coreReason = input.manual
    ? input.novelty != null
      ? `Manually requested — latest run scored ${Math.round(input.novelty)}% novelty (below the ${threshold}% stall threshold)`
      : "Manually requested variation — the user asked Evolution for a fresh angle"
    : `Novelty stalled at ${Math.round(input.novelty ?? 0)}% — recent runs of this pipeline produce near-duplicate output, so a fresh angle is proposed`;
  return {
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    status: "open",
    goal: `${base} — approach it from ${angle}`,
    reason:
      prior > 0
        ? `${coreReason} — branch rotated after ${prior} prior proposal${prior === 1 ? "" : "s"} for this pipeline (repeating the old angle would replay the same search trajectory)`
        : coreReason,
    sourceWorkflowId: input.sourceWorkflowId,
    sourceWorkflowName: input.sourceWorkflowName,
    sourceRunId: input.sourceRunId,
  };
}
