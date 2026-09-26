// ─── Evolution Layer core (r68: rebuilt natively in THIS sandbox) ───────────
// Novelty measurement for pipeline runs: token-shingle Jaccard vs recent runs
// of the same workflow. Low novelty (<35%) = the pipeline is treading water —
// surfaced as an amber 🧬 chip so stall becomes VISIBLE (anti-stall doctrine
// from the original r67.1 design, which lived in a sibling sandbox and never
// landed here; this file re-grounds it).

export function shingles(text: string, k = 8): Set<string> {
  const toks = text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
  if (toks.length < k) return new Set(toks.length ? [toks.join(" ")] : []);
  const out = new Set<string>();
  for (let i = 0; i <= toks.length - k; i++) out.add(toks.slice(i, i + k).join(" "));
  return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const s of a) if (b.has(s)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * Novelty % of a run vs its workflow's recent done runs (last `window`).
 * 100 = fully novel output; <35 = near-duplicate of something it already
 * produced (stall signal). Returns null when there is nothing to compare.
 */
export function scoreNovelty(
  currentOutput: string,
  prevOutputs: string[],
  window = 5
): number | null {
  const cur = shingles(currentOutput);
  if (!cur.size || !prevOutputs.length) return null;
  const maxSim = prevOutputs
    .slice(-window)
    .map((p) => jaccard(cur, shingles(p)))
    .reduce((m, x) => Math.max(m, x), 0);
  return Math.round((1 - maxSim) * 100);
}

/** Combined text of a run's step outputs (stable step order). */
export function runText(steps: Array<{ output?: string }>): string {
  return steps.map((s) => s.output || "").join("\n");
}
