#!/usr/bin/env python3
"""r199: repair the corrupt cold-start pick line in spawn-proposal-engine.ts
and add the decision-aware router (pickVariationAngleWithReason) + evidence-
citing proposal reasons. Surgical, assertion-guarded line/string replacement."""

p = "src/lib/spawn-proposal-engine.ts"
src = open(p, encoding="utf-8").read()
lines = src.split("\n")

# ── 1. Replace the whole pickVariationAngle block (lines 95-117, 1-indexed) ──
assert lines[94].startswith("export function pickVariationAngle"), lines[94]
assert lines[115].startswith("  return candidates"), lines[115]
assert lines[116] == "}", lines[116]

NEW_ROUTER = '''export type AngleDecision = {
  angle: string;
  /** How the router decided: "exploitation" = best past outcome novelty among
   * the least-used branches; "exploration" = least-used with no scored
   * history (hash tie-break); "cold-start" = legacy hash pick. */
  mode: "exploitation" | "exploration" | "cold-start";
  /** When exploitation fired: the branch that led and its evidence. */
  leader?: { angle: string; avgNovelty: number; samples: number };
};

/**
 * r199: decision-aware router — same selection as pickVariationAngle, but it
 * also reports HOW it decided so the proposal reason can cite the evidence
 * ("exploiting the leading branch, avg X% novelty over N scored variations").
 * pickVariationAngle keeps its string signature for existing callers/QA.
 */
export function pickVariationAngleWithReason(
  taskExcerpt: string,
  history: AngleHistoryEntry[] = []
): AngleDecision {
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
      const leader = scored[0];
      const samples = noveltySamples.get(leader) ?? [];
      return {
        angle: leader,
        mode: "exploitation",
        leader: { angle: leader, avgNovelty: avg(samples), samples: samples.length },
      };
    }
    // r199 FIX: the cold-start line had been corrupt in git history —
    // "return candidatesashIndex(taskExcerpt) % candidates.length];" — an
    // undefined symbol plus a stray bracket. Every toolchain (tsc incremental
    // cache, bun transpiler cache, Next dev module cache) served its CACHED
    // parse of the pre-corruption code, so nothing ever flagged it, but any
    // fresh parse (clean clone, CI, deploy build) would have failed to compile.
    return { angle: candidates[hashIndex(taskExcerpt) % candidates.length], mode: "exploration" };
  }
  return { angle: candidates[hashIndex(taskExcerpt) % candidates.length], mode: "cold-start" };
}

export function pickVariationAngle(taskExcerpt: string, history: AngleHistoryEntry[] = []): string {
  return pickVariationAngleWithReason(taskExcerpt, history).angle;
}'''

lines[94:117] = NEW_ROUTER.split("\n")
src = "\n".join(lines)

# ── 2. buildVariationProposal: use the decision, cite the evidence ──
old_pick = "  const angle = pickVariationAngle(base, input.angleHistory);"
new_pick = (
    "  // r199: the reason names the router's DECISION, not just the rotation count.\n"
    "  const decision = pickVariationAngleWithReason(base, input.angleHistory);\n"
    "  const angle = decision.angle;"
)
assert src.count(old_pick) == 1
src = src.replace(old_pick, new_pick)

old_reason = (
    "        ? `${coreReason} — branch rotated after ${prior} prior proposal${prior === 1 ? \"\" : \"s\"} "
    "for this pipeline (repeating the old angle would replay the same search trajectory)`"
)
new_reason = (
    "        ? `${coreReason} — ${decisionNote || rotationNote} "
    "(repeating the old angle would replay the same search trajectory)`"
)
assert src.count(old_reason) == 1, "reason ternary anchor not found"
src = src.replace(old_reason, new_reason)

old_ret = "  return {\n    id: crypto.randomUUID(),"
new_ret = (
    "  const decisionNote =\n"
    "    decision.mode === \"exploitation\" && decision.leader\n"
    "      ? `the router is exploiting the leading branch — \"${decision.leader.angle}\" averaged "
    "${Math.round(decision.leader.avgNovelty)}% novelty across ${decision.leader.samples} scored "
    "variation${decision.leader.samples === 1 ? \"\" : \"s\"}`\n"
    "      : decision.mode === \"exploration\"\n"
    "        ? \"the router is exploring — every scored branch is exhausted, so the least-tried angle gets its turn\"\n"
    "        : \"\";\n"
    "  const rotationNote = `branch rotated after ${prior} prior proposal${prior === 1 ? \"\" : \"s\"} for this pipeline`;\n"
    "  return {\n"
    "    id: crypto.randomUUID(),"
)
assert src.count(old_ret) == 1, "return anchor not found"
src = src.replace(old_ret, new_ret)

open(p, "w", encoding="utf-8").write(src)
print("OK: router block replaced, decision-aware reasons wired")
