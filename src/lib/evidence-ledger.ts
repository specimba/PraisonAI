/**
 * r184 — directive item (c): claim-to-source evidence ledger for research runs.
 *
 * The user's directive: research outputs make claims; the run must carry the
 * receipts. This module harvests every external URL referenced by a run's
 * step outputs and tool calls (search/fetch args and results), dedupes them,
 * and records WHICH step cited each source and HOW (in the prose output, in a
 * tool's fetched result, or in a tool's query arguments). Pure and
 * dependency-free so the QA script and the Markdown export can both use it.
 */
import type { WorkflowRunStep } from "./types";

export type CitationVia = "output" | "tool-result" | "tool-args";

export interface EvidenceCitation {
  stepId: string;
  label: string;
  agentName: string;
  via: CitationVia;
}

export interface EvidenceSource {
  /** Display URL — the first-seen spelling, tail-tidied. */
  url: string;
  domain: string;
  citedBy: EvidenceCitation[];
  /** 0-based index of the first step that cited this source. */
  firstStepIndex: number;
}

const URL_RE = /https?:\/\/[^\s<>"'`\]]+/g;

/**
 * Strip the trailing punctuation a greedy URL match picks up from prose
 * ("end of sentence.", "markdown (link)") while KEEPING balanced parens that
 * are part of the URL itself (Wikipedia-style .../A_(b)).
 */
export function tidyUrlTail(u: string): string {
  let end = u.length;
  while (end > 0) {
    const c = u[end - 1];
    if (c === ")") {
      const head = u.slice(0, end);
      const opens = (head.match(/\(/g) ?? []).length;
      const closes = (head.match(/\)/g) ?? []).length;
      if (closes > opens) {
        end--;
        continue;
      }
      break;
    }
    if (".,;:!?".includes(c)) {
      end--;
      continue;
    }
    break;
  }
  return u.slice(0, end);
}

/**
 * Canonical dedupe key: lowercase scheme+host, trailing slash stripped from
 * a non-root path. Path case is preserved (paths are case-sensitive).
 * Returns null for non-http(s) or unparseable strings.
 */
export function normalizeSourceUrl(u: string): string | null {
  try {
    const parsed = new URL(u);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    let path = parsed.pathname;
    if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
    return `${parsed.protocol}//${parsed.host.toLowerCase()}${path}${parsed.search}`;
  } catch {
    return null;
  }
}

/** Every URL-looking token in a text blob, tails tidied, order preserved. */
export function harvestUrls(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (const m of text.matchAll(URL_RE)) {
    const u = tidyUrlTail(m[0]);
    if (u && !out.includes(u)) out.push(u);
  }
  return out;
}

function domainOf(u: string): string {
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
}

/**
 * Build the run's evidence ledger: one entry per distinct source, sorted
 * most-cited first (ties by first appearance). Scans, per step: the prose
 * output, then each tool call's result and its query arguments — so a claim
 * can be traced to the fetch/search that backs it even when the prose omits
 * the link.
 */
export function buildEvidenceLedger(steps: Pick<WorkflowRunStep, "stepId" | "label" | "agentName" | "output" | "toolCalls">[]): EvidenceSource[] {
  const byKey = new Map<string, EvidenceSource>();
  steps.forEach((s, i) => {
    const citations: { url: string; via: CitationVia }[] = [
      ...harvestUrls(s.output ?? "").map((url) => ({ url, via: "output" as const })),
      ...(s.toolCalls ?? []).flatMap((t) => [
        ...harvestUrls(t.result ?? "").map((url) => ({ url, via: "tool-result" as const })),
        ...harvestUrls(t.args ?? "").map((url) => ({ url, via: "tool-args" as const })),
      ]),
    ];
    for (const { url, via } of citations) {
      const key = normalizeSourceUrl(url);
      if (!key) continue;
      let entry = byKey.get(key);
      if (!entry) {
        entry = { url, domain: domainOf(url), citedBy: [], firstStepIndex: i };
        byKey.set(key, entry);
      }
      const citation: EvidenceCitation = { stepId: s.stepId, label: s.label, agentName: s.agentName, via };
      const dup = entry.citedBy.some(
        (c) => c.stepId === citation.stepId && c.via === citation.via
      );
      if (!dup) entry.citedBy.push(citation);
    }
  });
  return [...byKey.values()].sort(
    (a, b) => b.citedBy.length - a.citedBy.length || a.firstStepIndex - b.firstStepIndex
  );
}
