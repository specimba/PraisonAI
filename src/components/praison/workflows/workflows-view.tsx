"use client";

import * as React from "react";
import { toast } from "sonner";
import {
  ChevronRight,
  Clock,
  Columns3,
  Copy,
  Download,
  Lightbulb,
  LayoutList,
  MoreVertical,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  ShieldAlert,
  Sparkles,
  Trash2,
  Upload,
  Users,
  Wand2,
  X,
} from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  useAgentsStore,
  useUiStore,
  useWorkflowsStore,
} from "@/lib/stores";
import type { SpawnProposal, Workflow, WorkflowStep } from "@/lib/types";
import { buildVariationProposal, NOVELTY_SPAWN_THRESHOLD } from "@/lib/spawn-proposal-engine";
import { useSettingsStore } from "@/lib/stores";
import { downloadJson, fmtIn, fmtIntervalShort, fmtRel, uid } from "@/lib/helpers";
import { cn } from "@/lib/utils";
import { AgentAvatar, DepthChip, EmptyState, PageHeader } from "@/components/praison/atoms";
import { WorkflowEditorDialog } from "./workflow-editor-dialog";
import { WorkflowRunPanel } from "./workflow-run-panel";
import { RunKanban } from "./run-kanban";

// ─── Workflow import/export helpers ─────────────────────────────────

function slugifyWf(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "workflow"
  );
}

function exportWorkflows(workflows: Workflow[]) {
  // Runs are history — not portable. Export the definition only.
  downloadJson(
    workflows.length === 1
      ? `praison-workflow-${slugifyWf(workflows[0].name)}.json`
      : "praison-workflows.json",
    {
      kind: "praison-workflows",
      version: 1,
      exportedAt: new Date().toISOString(),
      workflows: workflows.map((w) => ({
        name: w.name,
        description: w.description,
        steps: w.steps,
        ...(w.depth ? { depth: w.depth } : {}),
      })),
    }
  );
}

/** Validate an untrusted parsed value as a Workflow; returns null when unusable. */
function sanitizeWorkflow(raw: unknown, validAgentIds: Set<string>): Workflow | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const name = typeof r.name === "string" ? r.name.trim() : "";
  if (!name) return null;
  const str = (v: unknown, fallback = "") => (typeof v === "string" ? v : fallback);

  const rawSteps = Array.isArray(r.steps) ? r.steps : [];
  const steps: WorkflowStep[] = [];
  for (const rs of rawSteps) {
    if (!rs || typeof rs !== "object") continue;
    const s = rs as Record<string, unknown>;
    const agentId = typeof s.agentId === "string" ? s.agentId : "";
    if (!agentId || !validAgentIds.has(agentId)) continue; // drop steps w/o a local agent
    steps.push({
      id: uid("step"),
      agentId,
      label: str(s.label, "Step").slice(0, 200) || "Step",
      instruction: s.instruction ? str(s.instruction).slice(0, 2000) : undefined,
      kind: s.kind === "review" ? ("review" as const) : ("generate" as const),
    });
  }
  if (steps.length === 0) return null;

  const now = Date.now();
  return {
    id: uid("wf"),
    name: name.slice(0, 80),
    description: str(r.description).slice(0, 300),
    steps,
    runs: [],
    createdAt: now,
    updatedAt: now,
    ...(r.depth === "quick" || r.depth === "standard" || r.depth === "deep"
      ? { depth: r.depth as Workflow["depth"] }
      : {}),
  };
}

// ─── Evolution ledger · per-workflow novelty trajectory (r68 follow-up) ──────

/**
 * Compact novelty ledger over run history: one row per workflow that has done
 * runs, showing the last 6 done runs' novelty scores as a colored trail strip
 * (oldest → newest), a ▲/▼ delta vs the previous scored run, and the latest
 * score chip. Amber <35% = stall signal, matching the kanban 🧬 chip doctrine.
 * Self-hides when no workflow has finished a run yet.
 */
function EvolutionLedger({ workflows }: { workflows: Workflow[] }) {
  const addProposal = useWorkflowsStore((s) => s.addProposal);
  const proposals = useWorkflowsStore((s) => s.proposals);
  const rows = React.useMemo(
    () =>
      workflows
        .map((wf) => ({ wf, done: wf.runs.filter((r) => r.status === "done") }))
        .filter((r) => r.done.length > 0),
    [workflows]
  );

  const allScored = React.useMemo(
    () => rows.flatMap((r) => r.done.filter((x) => x.novelty != null)),
    [rows]
  );
  const avg = allScored.length
    ? Math.round(allScored.reduce((s, r) => s + (r.novelty ?? 0), 0) / allScored.length)
    : null;
  const threshold =
    useSettingsStore((s) => s.settings.noveltySpawnThreshold) ??
    NOVELTY_SPAWN_THRESHOLD;
  const stalled = allScored.filter((r) => (r.novelty ?? 0) < threshold).length;

  if (rows.length === 0) return null;

  return (
    <Card className="mb-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span aria-hidden>🧬</span>
          <h3 className="text-sm font-semibold">Evolution ledger</h3>
          <span className="hidden truncate text-xs text-muted-foreground sm:inline">
            output novelty vs recent done runs · &lt;{threshold}% = stall
          </span>
        </div>
        {allScored.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 text-[10px] font-medium">
            <span
              title={`${allScored.length} run${allScored.length === 1 ? "" : "s"} scored by the Evolution Layer (runs finish with a novelty score vs their workflow's recent output)`}
              className="rounded-full border bg-muted/40 px-2 py-0.5 text-muted-foreground"
            >
              {allScored.length} scored
            </span>
            <span
              title={`Average novelty across all scored runs${avg != null ? `: ${avg}%` : ""}`}
              className={cn(
                "rounded-full border px-2 py-0.5",
                avg != null && avg < threshold
                  ? "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400"
                  : "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
              )}
            >
              avg {avg}%
            </span>
            {stalled > 0 && (
              <span
                title={`${stalled} near-duplicate run${stalled === 1 ? "" : "s"} — the pipeline is treading water; widen the task or vary instructions`}
                className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-amber-600 dark:text-amber-400"
              >
                {stalled} stalled
              </span>
            )}
          </div>
        )}
      </div>

      <div className="mt-3 space-y-1.5">
        {rows.map(({ wf, done }) => {
          const latest = done[0];
          const n = latest.novelty;
          const prevScored = done.slice(1).find((r) => r.novelty != null);
          const delta =
            n != null && prevScored?.novelty != null ? n - prevScored.novelty : null;
          const trail = done.slice(0, 6).reverse(); // oldest → newest
          return (
            <div
              key={wf.id}
              className="flex items-center justify-between gap-3 rounded-lg border bg-muted/20 px-3 py-2"
            >
              <div className="min-w-0">
                <div className="truncate text-xs font-medium">{wf.name}</div>
                <div className="text-[10px] text-muted-foreground">
                  {done.length} done run{done.length === 1 ? "" : "s"}
                  {latest.finishedAt ? ` · last ${fmtRel(latest.finishedAt)}` : ""}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {trail.map((r) => {
                  const v = r.novelty;
                  return (
                    <span
                      key={r.id}
                      title={`${fmtRel(r.startedAt)}${v != null ? ` · novelty ${v}%${v < threshold ? " — stall signal" : ""}` : " · not scored (finished before the Evolution Layer landed; re-run to score)"}`}
                      className={cn(
                        "flex h-5 min-w-8 items-center justify-center rounded px-1 text-[10px] font-medium tabular-nums",
                        v == null
                          ? "bg-muted text-muted-foreground/60"
                          : v < threshold
                            ? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
                            : "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                      )}
                    >
                      {v != null ? v : "·"}
                    </span>
                  );
                })}
                {delta != null && delta !== 0 && (
                  <span
                    title={`${delta > 0 ? "+" : ""}${delta}% vs the previous scored run`}
                    className={cn(
                      "text-[10px] font-semibold",
                      delta > 0
                        ? "text-emerald-500"
                        : "text-amber-500"
                    )}
                  >
                    {delta > 0 ? "▲" : "▼"}
                  </span>
                )}
                <span
                  title={
                    n != null
                      ? `Evolution novelty vs recent runs: ${n}%${n < threshold ? " — stall signal (near-duplicate output)" : ""}`
                      : "Latest run finished before the Evolution Layer landed — re-run to score"
                  }
                  className={cn(
                    "ml-1 inline-flex h-6 items-center rounded-full border px-2 text-[10px] font-semibold",
                    n == null
                      ? "text-muted-foreground"
                      : n < threshold
                        ? "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400"
                        : "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                  )}
                >
                  {n != null ? `🧬 ${n}%` : "not scored"}
                </span>
                {n != null && n < threshold && !proposals.some((p) => p.status === "open" && p.sourceWorkflowId === wf.id) && (
                  <button
                    title={`Propose a variation of "${wf.name}" to the Evolution Inbox — latest run stalled at ${n}%`}
                    onClick={() => {
                      addProposal(
                        buildVariationProposal({
                          sourceWorkflowId: wf.id,
                          sourceWorkflowName: wf.name,
                          sourceRunId: latest.id,
                          taskExcerpt:
                            wf.steps[0]?.instruction ||
                            wf.steps.map((s) => s.label).join(" → ") ||
                            wf.name,
                          novelty: n,
                          manual: true,
                        })
                      );
                      toast.success("Variation proposed — waiting in the Evolution Inbox", {
                        description: `${wf.name} · spawn it into a real pipeline with one click`,
                      });
                    }}
                    className="ml-1 inline-flex h-6 items-center gap-1 rounded-full border border-violet-500/30 bg-violet-500/10 px-2 text-[10px] font-semibold text-violet-600 transition-colors hover:bg-violet-500/20 dark:text-violet-400"
                  >
                    <Sparkles className="h-3 w-3" />
                    Suggest variation
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

// ─── Plan → Pipeline · one-click composer (paste a plan, get a workflow) ─────

/** First line = goal; the rest = steps (bullet/numbered markers stripped). */
function parsePlan(text: string): { goal: string; steps: string[] } {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return { goal: "", steps: [] };
  const goal = lines[0].replace(/^#+\s*/, "").slice(0, 200);
  const steps = lines
    .slice(1)
    .map((l) =>
      l
        .replace(/^(?:[-*•·]|\d+[.)])\s*/, "")
        .replace(/^step\s*\d+\s*[:.]\s*/i, "")
        .trim()
    )
    .filter(Boolean)
    .slice(0, 8);
  return { goal, steps };
}

function PlanPipelineDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const agents = useAgentsStore((s) => s.agents);
  const addWf = useWorkflowsStore((s) => s.add);
  const [planText, setPlanText] = React.useState("");
  const [reviewGate, setReviewGate] = React.useState(true);
  const [selected, setSelected] = React.useState<string[]>([]);

  // Default-select the whole roster (order stable) each time the dialog opens.
  React.useEffect(() => {
    if (open) setSelected(agents.map((a) => a.id));
  }, [open, agents]);

  const { goal, steps: planSteps } = parsePlan(planText);
  const scaffold = planSteps.length === 0;
  const stepLines = scaffold
    ? ["Research the goal and gather context", "Draft the deliverable"]
    : planSteps;
  const canCreate = goal.length > 0 && selected.length > 0;

  const toggle = (id: string) =>
    setSelected((cur) =>
      cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]
    );

  const create = () => {
    if (!canCreate) return;
    const steps: WorkflowStep[] = stepLines.map((label, i) => ({
      id: uid("step"),
      agentId: selected[i % selected.length],
      label: label.slice(0, 120) || `Step ${i + 1}`,
      instruction: goal,
      kind: "generate" as const,
    }));
    if (reviewGate) {
      steps.push({
        id: uid("step"),
        agentId: selected[selected.length - 1],
        label: "Review & refine",
        instruction: `Audit the final output against the goal — ${goal}. Force a rework if it falls short.`,
        kind: "review" as const,
      });
    }
    addWf({
      name: goal.slice(0, 80),
      description: scaffold
        ? `Auto-composed scaffold · ${steps.length} steps`
        : `From pasted plan · ${steps.length} steps`,
      steps,
      depth: "standard",
      runs: [],
    });
    toast.success(
      `Pipeline created with ${steps.length} step${steps.length === 1 ? "" : "s"} — ready to run`
    );
    setPlanText("");
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Wand2 className="h-4 w-4 text-violet-400" aria-hidden />
            Plan → Pipeline
          </DialogTitle>
          <DialogDescription>
            Paste a goal or plan — the first line becomes the workflow, each
            further line becomes a step mapped across your agents.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="plan-text">Plan or goal</Label>
            <textarea
              id="plan-text"
              value={planText}
              onChange={(e) => setPlanText(e.target.value)}
              rows={6}
              placeholder={
                "Launch a niche SaaS blog\n- Research competitor positioning\nDraft the first 3 articles\nBuild a publishing calendar"
              }
              className="w-full resize-y rounded-lg border bg-transparent px-3 py-2 text-sm shadow-sm outline-none transition placeholder:text-muted-foreground/50 focus-visible:border-violet-500/40 focus-visible:ring-2 focus-visible:ring-violet-500/20"
            />
            <p
              className={cn(
                "text-xs",
                goal
                  ? planSteps.length
                    ? "text-emerald-600 dark:text-emerald-400"
                    : "text-muted-foreground"
                  : "text-muted-foreground/60"
              )}
            >
              {goal
                ? planSteps.length
                  ? `✓ ${planSteps.length} step${planSteps.length === 1 ? "" : "s"} detected — mapped to agents in order`
                  : "No step lines — a Research → Draft scaffold will be composed for you"
                : "Tip: one step per line; bullets and numbering are stripped automatically"}
            </p>
          </div>

          <div className="space-y-2">
            <Label>
              Agents in rotation ({selected.length}/{agents.length})
            </Label>
            <div className="flex flex-wrap gap-1.5">
              {agents.map((a) => {
                const on = selected.includes(a.id);
                return (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => toggle(a.id)}
                    aria-pressed={on}
                    className={cn(
                      "flex items-center gap-1.5 rounded-full border py-1 pl-1 pr-2.5 transition",
                      on
                        ? "border-violet-500/40 bg-violet-500/10"
                        : "border bg-muted/40 opacity-50 hover:opacity-80"
                    )}
                  >
                    <AgentAvatar agent={a} size="xs" />
                    <span className="max-w-28 truncate text-xs font-medium">
                      {a.name}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Checkbox
              id="review-gate"
              checked={reviewGate}
              onCheckedChange={(v) => setReviewGate(v === true)}
            />
            <Label
              htmlFor="review-gate"
              className="cursor-pointer text-sm font-normal text-muted-foreground"
            >
              Append a review gate step (audits the final output, forces rework)
            </Label>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={create} disabled={!canCreate}>
            <Wand2 className="h-4 w-4" />
            Create pipeline
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Evolution Inbox · pipeline-born spawn proposals ───────────────────────

/** Compact relative time for inbox rows ("just now", "5m ago", "3h ago", date fallback). */
function proposalAge(ts: number): string {
  const dt = Date.now() - ts;
  if (dt < 60_000) return "just now";
  if (dt < 3_600_000) return `${Math.floor(dt / 60_000)}m ago`;
  if (dt < 86_400_000) return `${Math.floor(dt / 3_600_000)}h ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function EvolutionInbox() {
  const proposals = useWorkflowsStore((s) => s.proposals);
  const setProposalStatus = useWorkflowsStore((s) => s.setProposalStatus);
  const agents = useAgentsStore((s) => s.agents);
  const addWf = useWorkflowsStore((s) => s.add);
  const clearProposals = useWorkflowsStore((s) => s.clearProposals);
  const threshold =
    useSettingsStore((s) => s.settings.noveltySpawnThreshold) ??
    NOVELTY_SPAWN_THRESHOLD;
  const [showArchive, setShowArchive] = React.useState(false);
  const [archiveFilter, setArchiveFilter] = React.useState<"all" | "accepted" | "dismissed">("all");
  const [confirmClear, setConfirmClear] = React.useState(false);

  const open = proposals.filter((p) => p.status === "open");
  const acceptedCount = proposals.filter((p) => p.status === "accepted").length;
  const dismissedCount = proposals.filter((p) => p.status === "dismissed").length;

  // Inbox clear? Keep a muted cycle summary instead of vanishing — the strip
  // teaches the loop and expands into an archive of handled proposals.
  if (open.length === 0) {
    if (acceptedCount + dismissedCount === 0) return null;
    const handled = proposals
      .filter((p) => p.status !== "open")
      .sort((a, b) => b.createdAt - a.createdAt);
    const history =
      archiveFilter === "all"
        ? handled
        : handled.filter((p) => p.status === archiveFilter);
    return (
      <div className="mb-4 rounded-xl border border-violet-500/15 bg-violet-500/[0.03] p-3">
        <button
          onClick={() => setShowArchive((v) => !v)}
          aria-expanded={showArchive}
          aria-label="Toggle Evolution proposal archive"
          className="flex w-full items-center gap-2 text-left"
        >
          <Lightbulb className="h-3.5 w-3.5 shrink-0 text-violet-500/70" />
          <span className="min-w-0 flex-1 text-xs leading-relaxed text-muted-foreground">
            Evolution cycle:{" "}
            <span className="font-medium text-foreground/80">
              {acceptedCount} spawned
            </span>
            {dismissedCount > 0 && <> · {dismissedCount} dismissed</>} — inbox
            clear. New proposals appear here automatically when runs stall
            (&lt;{threshold}% novelty) or via{" "}
            <span className="font-medium text-foreground/80">
              Suggest variation
            </span>{" "}
            in the ledger.
          </span>
          <span className="shrink-0 rounded-full border border-violet-500/25 bg-violet-500/10 px-2 py-0.5 text-[10px] font-medium text-violet-600 transition-colors hover:bg-violet-500/20 dark:text-violet-400">
            {showArchive ? "Hide history" : `History (${handled.length})`}
          </span>
        </button>
        {showArchive && (
          <>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {(
                [
                  ["all", `All (${handled.length})`],
                  ["accepted", `Spawned (${acceptedCount})`],
                  ["dismissed", `Dismissed (${dismissedCount})`],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => setArchiveFilter(key)}
                  aria-pressed={archiveFilter === key}
                  className={cn(
                    "rounded-full border px-2 py-0.5 text-[10px] font-medium transition-colors",
                    archiveFilter === key
                      ? "border-violet-500/40 bg-violet-500/15 text-violet-600 dark:text-violet-400"
                      : "border-border bg-muted/30 text-muted-foreground hover:bg-muted/60"
                  )}
                >
                  {label}
                </button>
              ))}
              <span className="flex-1" />
              <button
                onClick={() => {
                  if (!confirmClear) {
                    setConfirmClear(true);
                    return;
                  }
                  clearProposals();
                  setConfirmClear(false);
                  setShowArchive(false);
                  toast.success("Evolution history cleared — open proposals (if any) are kept");
                }}
                className={cn(
                  "rounded-full border px-2 py-0.5 text-[10px] font-medium transition-colors",
                  confirmClear
                    ? "border-red-500/40 bg-red-500/15 text-red-600 dark:text-red-400"
                    : "border-border bg-muted/30 text-muted-foreground hover:bg-muted/60"
                )}
              >
                {confirmClear ? "Really clear?" : "Clear history"}
              </button>
            </div>
            <div className="mt-1.5 space-y-1.5">
              {history.length === 0 ? (
                <p className="rounded-lg border bg-background/60 px-2.5 py-2 text-xs text-muted-foreground">
                  Nothing here for this filter yet.
                </p>
              ) : (
                history.slice(0, 8).map((p) => (
                  <div
                    key={p.id}
                    className="flex items-center gap-2 rounded-lg border bg-background/60 px-2.5 py-1.5"
                  >
                    {p.status === "accepted" ? (
                      <Sparkles className="h-3 w-3 shrink-0 text-violet-500" aria-hidden />
                    ) : (
                      <X className="h-3 w-3 shrink-0 text-muted-foreground/60" aria-hidden />
                    )}
                    <span className="min-w-0 flex-1 truncate text-xs">{p.goal}</span>
                    <span className="shrink-0 text-[10px] text-muted-foreground">
                      from {p.sourceWorkflowName} · {proposalAge(p.createdAt)}
                    </span>
                  </div>
                ))
              )}
            </div>
          </>
        )}
      </div>
    );
  }

  const accept = (p: SpawnProposal) => {
    const roster = agents.map((a) => a.id);
    if (roster.length === 0) {
      toast.error("No agents in the roster — create an agent first");
      return;
    }
    const parsed = parsePlan([p.goal, ...(p.planLines ?? [])].join("\n"));
    const stepLines = parsed.steps.length
      ? parsed.steps
      : ["Research the goal and gather context", "Draft the deliverable"];
    const steps: WorkflowStep[] = stepLines.map((label, i) => ({
      id: uid("step"),
      agentId: roster[i % roster.length],
      label: label.slice(0, 120) || `Step ${i + 1}`,
      instruction: parsed.goal,
      kind: "generate" as const,
    }));
    steps.push({
      id: uid("step"),
      agentId: roster[roster.length - 1],
      label: "Review & refine",
      instruction: `Audit the final output against the goal — ${parsed.goal}. Force a rework if it falls short.`,
      kind: "review" as const,
    });
    addWf({
      name: parsed.goal.slice(0, 80),
      description: `Evolution spawn · from "${p.sourceWorkflowName}" · ${p.reason}`,
      steps,
      depth: "standard",
      runs: [],
    });
    setProposalStatus(p.id, "accepted");
    toast.success(
      `Spawned "${parsed.goal.slice(0, 80)}" with ${steps.length} steps — review gate included`
    );
  };

  return (
    <div className="rounded-xl border border-violet-500/25 bg-violet-500/[0.04] p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Lightbulb className="h-4 w-4 shrink-0 text-violet-500" />
        <span className="text-sm font-medium">Evolution Inbox</span>
        <span className="rounded-full border border-violet-500/30 bg-violet-500/10 px-2 py-0.5 text-[10px] font-medium text-violet-600 dark:text-violet-400">
          {open.length} proposal{open.length === 1 ? "" : "s"}
        </span>
        <span className="text-xs text-muted-foreground">
          pipelines suggested by your workflows — spawn or dismiss
        </span>
      </div>
      <div className="space-y-2">
        {open.map((p) => (
          <div
            key={p.id}
            className="flex items-start gap-3 rounded-lg border bg-background/60 p-2.5"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{p.goal}</p>
              <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                {p.reason} · from{" "}
                <span className="font-medium text-foreground/80">
                  {p.sourceWorkflowName}
                </span>{" "}
                ·{" "}
                <span
                  className="ml-0.5 inline-flex items-center rounded-full border border-violet-500/25 bg-violet-500/10 px-1.5 py-px text-[10px] font-medium text-violet-600 dark:text-violet-400"
                  title={new Date(p.createdAt).toLocaleString()}
                >
                  {proposalAge(p.createdAt)}
                </span>
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <Button
                size="sm"
                onClick={() => accept(p)}
                aria-label={`Spawn pipeline from proposal: ${p.goal}`}
              >
                <Sparkles className="h-3.5 w-3.5" />
                Spawn
              </Button>
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Dismiss proposal: ${p.goal}`}
                onClick={() => {
                  setProposalStatus(p.id, "dismissed");
                  toast("Proposal dismissed — archived in Evolution history");
                }}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Workflow Studio · grid of pipelines, editor dialog + run panel ─────────

export function WorkflowsView() {
  const workflows = useWorkflowsStore((s) => s.workflows);
  const agents = useAgentsStore((s) => s.agents);
  const addWf = useWorkflowsStore((s) => s.add);
  const duplicateWf = useWorkflowsStore((s) => s.duplicate);
  const removeWf = useWorkflowsStore((s) => s.remove);
  const updateWf = useWorkflowsStore((s) => s.update);

  // Keep schedule countdowns honest (cheap re-render every 30s when needed)
  const hasSchedules = workflows.some((w) => w.schedule?.enabled);
  const [, tick] = React.useReducer((n: number) => n + 1, 0);
  React.useEffect(() => {
    if (!hasSchedules) return;
    const t = setInterval(tick, 30_000);
    return () => clearInterval(t);
  }, [hasSchedules, tick]);

  const activeSchedules = workflows.filter(
    (w) => w.schedule?.enabled && w.steps.length > 0
  ).length;

  const [editorOpen, setEditorOpen] = React.useState(false);
  const [planOpen, setPlanOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<Workflow | null>(null);
  const [runOpen, setRunOpen] = React.useState(false);
  const [running, setRunning] = React.useState<Workflow | null>(null);
  const [deleteTarget, setDeleteTarget] = React.useState<Workflow | null>(null);
  const [pendingRunFocus, setPendingRunFocus] = React.useState<string | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);

  // Grid ↔ board layout toggle (persisted in the ui store)
  const boardOpen = useUiStore((s) => s.workflowBoardOpen);
  const setBoardOpen = useUiStore((s) => s.setWorkflowBoardOpen);

  const agentById = React.useMemo(
    () => new Map(agents.map((a) => [a.id, a])),
    [agents]
  );

  // The command palette (⌘K) can request a workflow run from anywhere
  const pendingRunId = useUiStore((s) => s.pendingRunWorkflowId);
  const clearPendingRun = useUiStore((s) => s.clearPendingRunWorkflow);
  React.useEffect(() => {
    if (!pendingRunId) return;
    const wf = useWorkflowsStore.getState().workflows.find((w) => w.id === pendingRunId);
    clearPendingRun();
    if (wf && wf.steps.length > 0) {
      setRunning(wf);
      setRunOpen(true);
    } else if (wf) {
      toast.error(`“${wf.name}” has no steps yet — add agents first.`, {
        action: {
          label: "Edit",
          onClick: () => {
            setEditing(wf);
            setEditorOpen(true);
          },
        },
      });
    }
  }, [pendingRunId, clearPendingRun]);

  const openNew = React.useCallback(() => {
    setEditing(null);
    setEditorOpen(true);
  }, []);

  const openEdit = React.useCallback((wf: Workflow) => {
    setEditing(wf);
    setEditorOpen(true);
  }, []);

  const openRun = React.useCallback((wf: Workflow) => {
    setRunning(wf);
    setPendingRunFocus(null);
    setRunOpen(true);
  }, []);

  /** Kanban card → open the run panel on that specific run. */
  const openRunFromBoard = React.useCallback((workflowId: string, runId?: string) => {
    const wf = useWorkflowsStore.getState().workflows.find((w) => w.id === workflowId);
    if (!wf) return;
    setRunning(wf);
    setPendingRunFocus(runId ?? null);
    setRunOpen(true);
  }, []);

  /** One-click resume for an auto-paused schedule (inverse of the runner's failStreak auto-pause). */
  const resumeSchedule = (wf: Workflow) => {
    if (!wf.schedule) return;
    updateWf(wf.id, {
      schedule: { ...wf.schedule, enabled: true, failStreak: 0, nextRunAt: undefined },
    });
    toast.success(`Schedule resumed — "${wf.name}" fires on the next tick`, {
      description: "Failure counter reset · the scheduler re-arms from now",
    });
  };

  const handleDuplicate = (wf: Workflow) => {
    const id = duplicateWf(wf.id);
    if (id) toast.success(`Duplicated "${wf.name}"`);
  };

  const handleDelete = () => {
    if (!deleteTarget) return;
    removeWf(deleteTarget.id);
    toast.success(`Deleted "${deleteTarget.name}"`);
    setDeleteTarget(null);
  };

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-importing the same file
    if (!file) return;
    try {
      const text = await file.text();
      const parsed: unknown = JSON.parse(text);
      const list = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === "object" && Array.isArray((parsed as { workflows?: unknown }).workflows)
          ? (parsed as { workflows: unknown[] }).workflows
          : null;
      if (!list) {
        toast.error("Invalid workflow file", {
          description: "Expected a workflows array or a PraisonAI export.",
        });
        return;
      }
      const validAgentIds = new Set(useAgentsStore.getState().agents.map((a) => a.id));
      const imported = list
        .map((w) => sanitizeWorkflow(w, validAgentIds))
        .filter((w): w is Workflow => w !== null);
      if (imported.length === 0) {
        toast.error("No usable workflows found", {
          description: "Workflows need a name and at least one step whose agent exists in your roster.",
        });
        return;
      }
      for (const w of imported) addWf(w);
      const skipped = list.length - imported.length;
      toast.success(
        `Imported ${imported.length} workflow${imported.length === 1 ? "" : "s"}` +
          (skipped > 0 ? ` (${skipped} skipped)` : "")
      );
    } catch {
      toast.error("Could not read that file as JSON.");
    }
  };

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Workflow Studio"
        description="Chain agents into sequential multi-agent pipelines"
      >
        {activeSchedules > 0 && (
          <span
            title={`${activeSchedules} workflow${activeSchedules === 1 ? "" : "s"} on a recurring schedule`}
            className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-600 dark:text-emerald-400"
          >
            <Clock className="h-3.5 w-3.5" aria-hidden />
            {activeSchedules} scheduled
          </span>
        )}
        <div
          role="radiogroup"
          aria-label="Layout"
          className="flex overflow-hidden rounded-lg border"
        >
          <button
            type="button"
            role="radio"
            aria-checked={!boardOpen}
            aria-label="Card grid layout"
            title="Card grid"
            onClick={() => setBoardOpen(false)}
            className={cn(
              "flex h-8 items-center gap-1.5 px-2.5 text-xs font-medium transition-colors",
              !boardOpen
                ? "bg-violet-500/15 text-violet-500 dark:text-violet-400"
                : "text-muted-foreground hover:bg-muted"
            )}
          >
            <LayoutList className="h-3.5 w-3.5" aria-hidden />
            <span className="hidden sm:inline">Pipelines</span>
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={boardOpen}
            aria-label="Runs board layout"
            title="Runs board"
            onClick={() => setBoardOpen(true)}
            className={cn(
              "flex h-8 items-center gap-1.5 border-l px-2.5 text-xs font-medium transition-colors",
              boardOpen
                ? "bg-violet-500/15 text-violet-500 dark:text-violet-400"
                : "text-muted-foreground hover:bg-muted"
            )}
          >
            <Columns3 className="h-3.5 w-3.5" aria-hidden />
            <span className="hidden sm:inline">Runs board</span>
          </button>
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={agents.length === 0}
          onClick={() => setPlanOpen(true)}
          aria-label="Create a pipeline from a pasted plan"
          title="Paste a plan — one click composes a pipeline across your agents"
        >
          <Wand2 className="h-4 w-4" />
          <span className="hidden md:inline">Plan → Pipeline</span>
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => fileInputRef.current?.click()}
          aria-label="Import workflows"
        >
          <Upload className="h-4 w-4" />
          <span className="hidden sm:inline">Import</span>
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={workflows.length === 0}
          onClick={() => exportWorkflows(workflows)}
          aria-label="Export all workflows"
        >
          <Download className="h-4 w-4" />
          <span className="hidden sm:inline">Export</span>
        </Button>
        <Button size="sm" onClick={openNew} aria-label="New Workflow">
          <Plus className="h-4 w-4" />
          New Workflow
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(e) => void handleImportFile(e)}
          aria-hidden
          tabIndex={-1}
        />
      </PageHeader>

      <div className="flex-1 overflow-y-auto p-4 md:p-6">
        {agents.length === 0 ? (
          <Alert className="mb-4 border-violet-500/30 bg-violet-500/5">
            <Users className="h-4 w-4 text-violet-400" />
            <AlertTitle>You need at least one agent to build workflows</AlertTitle>
            <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
              <span className="text-muted-foreground">
                Agents are the workers of a pipeline — create them first, then compose steps.
              </span>
              <Button
                size="sm"
                variant="outline"
                onClick={() => useUiStore.getState().setView("agents")}
              >
                Go to Agents
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}

        <EvolutionInbox />
        <EvolutionLedger workflows={workflows} />

        {boardOpen ? (
          <RunKanban onSelect={openRunFromBoard} />
        ) : workflows.length === 0 ? (
          <EmptyState
            emoji="🧩"
            title="No workflows yet"
            description="Compose agents into a pipeline — e.g. Researcher → Planner → Writer."
            action={
              <Button size="sm" onClick={openNew}>
                <Plus className="h-4 w-4" />
                New Workflow
              </Button>
            }
          />
        ) : (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {workflows.map((wf) => {
              const lastRun = wf.runs[0];
              return (
                <Card key={wf.id} className="card-lift gap-3 p-4">
                  <div className="flex items-start justify-between gap-2">
                    <h3 className="min-w-0 truncate text-sm font-semibold md:text-[15px]">
                      {wf.name}
                    </h3>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 shrink-0"
                          aria-label={`Actions for ${wf.name}`}
                        >
                          <MoreVertical className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-40">
                        <DropdownMenuItem onClick={() => openRun(wf)}>
                          <Play className="h-4 w-4" />
                          Run
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => openEdit(wf)}>
                          <Pencil className="h-4 w-4" />
                          Edit
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => handleDuplicate(wf)}>
                          <Copy className="h-4 w-4" />
                          Duplicate
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => exportWorkflows([wf])}>
                          <Download className="h-4 w-4" />
                          Export
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          variant="destructive"
                          onClick={() => setDeleteTarget(wf)}
                        >
                          <Trash2 className="h-4 w-4" />
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>

                  {wf.description ? (
                    <p className="line-clamp-1 text-sm text-muted-foreground">
                      {wf.description}
                    </p>
                  ) : null}

                  <div
                    className="flex flex-wrap items-center gap-1.5"
                    aria-label={`${wf.steps.length} steps`}
                  >
                    {wf.steps.map((step, i) => {
                      const agent = agentById.get(step.agentId);
                      const isReview = (step.kind ?? "generate") === "review";
                      return (
                        <React.Fragment key={step.id}>
                          {i > 0 ? (
                            <ChevronRight
                              className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                              aria-hidden
                            />
                          ) : null}
                          <span
                            title={step.label || agent?.name}
                            className={cn(
                              "flex items-center gap-1.5 rounded-full border py-1 pl-1 pr-2.5",
                              isReview
                                ? "border-amber-500/40 bg-amber-500/10"
                                : "border bg-muted/40"
                            )}
                          >
                            {isReview ? (
                              <ShieldAlert
                                className="ml-1 h-3 w-3 shrink-0 text-amber-500"
                                aria-hidden
                              />
                            ) : null}
                            <AgentAvatar agent={agent} size="xs" />
                            <span className="max-w-32 truncate text-xs font-medium">
                              {agent?.name ?? step.label ?? "Unassigned"}
                            </span>
                          </span>
                        </React.Fragment>
                      );
                    })}
                    {wf.steps.length === 0 ? (
                      <span className="text-xs text-muted-foreground">
                        No steps yet — edit to add some
                      </span>
                    ) : null}
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <DepthChip depth={wf.depth} />
                      <span className="text-[11px] text-muted-foreground">
                        {lastRun
                          ? `${wf.runs.length} run${wf.runs.length === 1 ? "" : "s"} · last ${fmtRel(lastRun.startedAt)}`
                          : "Never run"}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      {wf.schedule?.enabled && wf.steps.length > 0 && (
                        <span
                          title={`Recurring schedule · next ${fmtIn(wf.schedule.nextRunAt)}${wf.schedule.failStreak ? ` · ${wf.schedule.failStreak} consecutive failure${wf.schedule.failStreak === 1 ? "" : "s"}` : ""}`}
                          className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400"
                        >
                          <span className="relative flex h-1.5 w-1.5">
                            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-60" />
                            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
                          </span>
                          {fmtIntervalShort(wf.schedule.intervalMs)} · next {fmtIn(wf.schedule.nextRunAt)}
                        </span>
                      )}
                      {wf.schedule && !wf.schedule.enabled && (wf.schedule.failStreak ?? 0) >= 3 && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            resumeSchedule(wf);
                          }}
                          title="Auto-paused after 3 consecutive failed runs. Click to re-enable the schedule and reset the failure counter — it fires on the next 10s tick while the tab is open."
                          className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-red-500/30 bg-red-500/10 px-2 py-0.5 text-[10px] font-medium text-red-600 transition-colors hover:bg-red-500/20 dark:text-red-400"
                        >
                          <RotateCcw className="h-3 w-3" />
                          auto-paused · click to resume
                        </button>
                      )}
                      <Button size="sm" onClick={() => openRun(wf)}>
                        <Play className="h-3.5 w-3.5" />
                        Run
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => openEdit(wf)}>
                        <Pencil className="h-3.5 w-3.5" />
                        Edit
                      </Button>
                    </div>
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </div>

      <WorkflowEditorDialog
        open={editorOpen}
        onOpenChange={setEditorOpen}
        workflow={editing}
      />

      <PlanPipelineDialog open={planOpen} onOpenChange={setPlanOpen} />

      <WorkflowRunPanel
        open={runOpen}
        onOpenChange={(v) => {
          setRunOpen(v);
          if (!v) setPendingRunFocus(null);
        }}
        workflow={running}
        initialRunId={pendingRunFocus}
      />

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(v) => {
          if (!v) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{deleteTarget?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes the workflow and its run history. This action
              cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className={cn(
                "bg-red-600 text-white hover:bg-red-600/90 focus-visible:ring-red-600/40"
              )}
              onClick={handleDelete}
            >
              <Trash2 className="h-4 w-4" />
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
