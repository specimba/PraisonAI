/**
 * r184 — directive item (c): claim-to-source evidence ledger.
 * K-series: pure-function unit tests (harvest/tidy/normalize/build) + a real
 * runToMarkdown render + source-level integration assertions.
 * Run: bun run scripts/qa-evidence-ledger.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildEvidenceLedger,
  harvestUrls,
  normalizeSourceUrl,
  tidyUrlTail,
} from "../src/lib/evidence-ledger";
import { runToMarkdown } from "../src/lib/helpers";
import type { WorkflowRun, WorkflowRunStep } from "../src/lib/types";

const ROOT = process.cwd();
let pass = 0, fail = 0;
function ok(cond: boolean, name: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}`); }
}
function src(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

console.log("K1 — tidyUrlTail: prose punctuation vs real parens");
ok(tidyUrlTail("https://example.com/a.") === "https://example.com/a", "trailing sentence period stripped");
ok(tidyUrlTail("https://example.com/a,") === "https://example.com/a", "trailing comma stripped");
ok(tidyUrlTail("https://example.com/wiki/A_(b)") === "https://example.com/wiki/A_(b)", "balanced parens kept (Wikipedia style)");
ok(tidyUrlTail("https://example.com/a)") === "https://example.com/a", "unbalanced closing paren stripped (markdown link)");
ok(tidyUrlTail("https://example.com/a!:") === "https://example.com/a", "multi-char punctuation tail stripped");

console.log("K2 — harvestUrls: extraction + in-text dedupe");
ok(harvestUrls("see https://a.com/x and https://a.com/x again").length === 1, "duplicate URL in one blob collapses");
ok(harvestUrls("Read [the docs](https://docs.example.com/intro). Done.").includes("https://docs.example.com/intro"), "markdown link harvested, punctuation tail stripped");
ok(harvestUrls("no urls here").length === 0, "plain prose yields nothing");
ok(harvestUrls("").length === 0, "empty string safe");

console.log("K3 — normalizeSourceUrl: canonical dedupe key");
ok(normalizeSourceUrl("https://Example.com/a/") === "https://example.com/a", "host lowercased + trailing slash stripped");
ok(normalizeSourceUrl("ftp://example.com") === null, "non-http(s) rejected");
ok(normalizeSourceUrl("not a url") === null, "garbage rejected");
ok(normalizeSourceUrl("https://example.com/Path") === "https://example.com/Path", "path case preserved");

console.log("K4 — buildEvidenceLedger: citations, merge, sort");
const steps: Pick<WorkflowRunStep, "stepId" | "label" | "agentName" | "output" | "toolCalls">[] = [
  {
    stepId: "s1", label: "Scout", agentName: "Research Scout",
    output: "Overview at https://arxiv.org/abs/2401.1 (see also https://a.com/one).",
    toolCalls: [{ id: "t1", name: "web_search", args: '{"query":"arxiv 2401.1"}', result: "found https://arxiv.org/abs/2401.1 and https://b.com/two" }],
  },
  {
    stepId: "s2", label: "Deep pass", agentName: "Deep Diver",
    output: "Confirmed per https://arxiv.org/abs/2401.1.",
    toolCalls: [],
  },
  {
    stepId: "s3", label: "Local step", agentName: "Writer",
    output: "No sources here.",
    toolCalls: [],
  },
];
const ledger = buildEvidenceLedger(steps);
ok(ledger.length === 3, `3 distinct sources (got ${ledger.length})`);
const arxiv = ledger.find((e) => e.url.includes("arxiv.org"))!;
ok(arxiv != null && arxiv.citedBy.length === 3, "arxiv source cited 3×: output s1 + tool-result s1 + output s2");
ok(arxiv.citedBy.some((c) => c.via === "tool-result" && c.stepId === "s1"), "tool-result citation recorded with via");
ok(ledger[0] === arxiv, "most-cited source sorts first");
ok(ledger.find((e) => e.url === "https://b.com/two")?.citedBy[0].via === "tool-result", "URL only present in a tool result still lands in the ledger");
ok(buildEvidenceLedger([]).length === 0, "empty steps → empty ledger");
const localOnly = buildEvidenceLedger([{ stepId: "x", label: "L", agentName: "A", output: "plain", toolCalls: [] }]);
ok(localOnly.length === 0, "source-free run → empty ledger (no fabrication)");

console.log("K5 — export: runToMarkdown renders the ledger");
const run: WorkflowRun = {
  id: "r1", workflowId: "w1", workflowName: "Continuous Research", task: "t",
  status: "done", startedAt: Date.now() - 1000, finishedAt: Date.now(), steps: steps as WorkflowRunStep[],
};
const md = runToMarkdown({ name: "Continuous Research" }, run);
ok(md.includes("## Evidence ledger"), "ledger section present in export");
ok(md.includes("- https://arxiv.org/abs/2401.1 — cited by"), "source line lists the URL with citers");
ok(md.includes("(tool-result)"), "non-output citations disclose their via channel");
const emptyRun: WorkflowRun = { ...run, steps: [steps[2] as WorkflowRunStep] };
ok(!runToMarkdown({ name: "W" }, emptyRun).includes("Evidence ledger"), "no sources → no ledger section (honest absence)");

console.log("K6 — integration: wiring");
const helpers = src("src/lib/helpers.ts");
ok(/import \{ buildEvidenceLedger \} from "\.\/evidence-ledger";/.test(helpers), "helpers imports the ledger module");
const evidenceMod = src("src/lib/evidence-ledger.ts");
ok(!evidenceMod.includes("from \"./helpers\"") && !evidenceMod.includes("from \"@/lib/helpers\""), "no import cycle (evidence-ledger does not import helpers)");
ok(/import type \{ WorkflowRunStep \} from "\.\/types";/.test(evidenceMod), "module is type-only coupled to types");
const panel = src("src/components/praison/workflows/workflow-run-panel.tsx");
ok(/import \{ buildEvidenceLedger \} from "@\/lib\/evidence-ledger";/.test(panel), "run panel imports the ledger");
ok(/evidenceOpenRunId, setEvidenceOpenRunId/.test(panel), "panel has the per-row toggle state");
ok(/toggle evidence ledger/.test(panel), "evidence button present with an aria label");
ok(/Evidence ledger · \{ledger\.length\}/.test(panel), "expanded block renders the ledger header");

console.log(`\n${pass}/${pass + fail} assertions passed`);
process.exit(fail === 0 ? 0 : 1);
