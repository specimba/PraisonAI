"use client";

// ─── Runs Kanban: every pipeline run across every workflow, grouped by state ─
// Inspired by Untrivial-ai/agent-orchestrator ("Needs you" attention column)
// and cft0808/edict's 军机处 board with health badges.

import * as React from "react";
import {
  ArrowRight,
  Ban,
  Check,
  Clock,
  Loader2,
  Undo2,
  X,
} from "lucide-react";
import {
  useUiStore,
  useWorkflowsStore,
} from "@/lib/stores";
import { fmtIn, fmtIntervalShort, fmtMs, fmtRel } from "@/lib/helpers";
import type { Workflow, WorkflowRun } from "@/lib/types";
import { cn } from "@/lib/utils";

/** v24: one server-lane AutomationRun row (from /api/automation/sync GET). */
interface ServerRunRow {
  id: string;
  workflowId: string;
  workflowName: string;
  trigger: string;
  status: string;
  currentStep: number;
  stepsTotal: number;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

interface BoardCard {
  key: string;
  workflowId: string;
  workflowName: string;
  run?: WorkflowRun;
  server?: ServerRunRow;
  /** epoch ms of run start — uniform sort key across lanes */
  sortAt: number;
  /** Scheduled cards represent a workflow's next firing, not a stored run. */
  scheduled?: { intervalMs: number; nextRunAt?: number; lastRunAt?: number };
}

interface Column {
  id: "running" | "attention" | "done" | "scheduled";
  label: string;
  hint: string;
  dotClass: string;
  ringClass: string;
}

const COLUMNS: Column[] = [
  {
    id: "running",
    label: "Working",
    hint: "Runs streaming right now",
    dotClass: "bg-violet-500",
    ringClass: "border-t-violet-500/60",
  },
  {
    id: "attention",
    label: "Needs you",
    hint: "Failed or stopped runs waiting for a decision",
    dotClass: "bg-amber-500",
    ringClass: "border-t-amber-500/60",
  },
  {
    id: "done",
    label: "Done",
    hint: "Recently completed runs",
    dotClass: "bg-emerald-500",
    ringClass: "border-t-emerald-500/60",
  },
  {
    id: "scheduled",
    label: "Scheduled",
    hint: "Pipelines on a recurring schedule",
    dotClass: "bg-pink-500",
    ringClass: "border-t-pink-500/60",
  },
];

const MAX_PER_COLUMN = 10;

// v24: poll the server lane every 60s while the board is open — headless
// runs the tab never saw would otherwise stay invisible to the kanban.
function useServerRuns(enabled: boolean): ServerRunRow[] {
  const [serverRuns, setServerRuns] = React.useState<ServerRunRow[]>([]);
  React.useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    const load = async () => {
      try {
        const res = await fetch("/api/automation/sync");
        if (!res.ok) return;
        const json = (await res.json()) as { runs?: ServerRunRow[] };
        if (!stopped && Array.isArray(json.runs)) setServerRuns(json.runs);
      } catch {
        /* server briefly unreachable — next poll retries */
      }
    };
    void load();
    const t = setInterval(load, 60_000);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, [enabled]);
  return serverRuns;
}

function groupRuns(workflows: Workflow[], serverRuns: ServerRunRow[]): Record<Column["id"], BoardCard[]> {
  const cards: Record<Column["id"], BoardCard[]> = {
    running: [],
    attention: [],
    done: [],
    scheduled: [],
  };
  for (const wf of workflows) {
    for (const run of wf.runs) {
      const card: BoardCard = {
        key: run.id,
        workflowId: wf.id,
        workflowName: wf.name,
        run,
        sortAt: run.startedAt ?? 0,
      };
      if (run.status === "running") cards.running.push(card);
      else if (run.status === "error" || run.status === "stopped")
        cards.attention.push(card);
      else cards.done.push(card);
    }
    if (wf.schedule?.enabled && wf.steps.length > 0) {
      cards.scheduled.push({
        key: `sched-${wf.id}`,
        workflowId: wf.id,
        workflowName: wf.name,
        sortAt: wf.schedule.nextRunAt ?? 0,
        scheduled: {
          intervalMs: wf.schedule.intervalMs,
          nextRunAt: wf.schedule.nextRunAt,
          lastRunAt: wf.schedule.lastRunAt,
        },
      });
    }
  }
  // v24: merge the server lane — headless runs fired while the tab was
  // closed (built-in engine, results in the local DB) now share the board.
  for (const r of serverRuns) {
    const card: BoardCard = {
      key: `srv-${r.id}`,
      workflowId: r.workflowId,
      workflowName: r.workflowName,
      server: r,
      sortAt: Date.parse(r.startedAt) || 0,
    };
    if (r.status === "running") cards.running.push(card);
    else if (r.status === "error") cards.attention.push(card);
    else cards.done.push(card);
  }
  cards.running.sort((a, b) => a.sortAt - b.sortAt);
  cards.attention.sort((a, b) => b.sortAt - a.sortAt);
  cards.done.sort((a, b) => b.sortAt - a.sortAt);
  cards.scheduled.sort((a, b) => (a.scheduled!.nextRunAt ?? 0) - (b.scheduled!.nextRunAt ?? 0));
  cards.done = cards.done.slice(0, MAX_PER_COLUMN);
  cards.attention = cards.attention.slice(0, MAX_PER_COLUMN);
  return cards;
}

function RunCard({
  card,
  onSelect,
}: {
  card: BoardCard;
  onSelect: (workflowId: string, runId?: string) => void;
}) {
  const highlightId = useUiStore((s) => s.highlightWorkflowId);
  const spotlighted = highlightId === card.workflowId;
  if (card.scheduled) {
    return (
      <button
        type="button"
        onClick={() => onSelect(card.workflowId)}
        data-wf-card={card.workflowId}
        className={cn(
          "group w-full rounded-xl border border-pink-500/25 bg-card/80 p-3 text-left shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:border-pink-500/50 hover:shadow-md hover:shadow-pink-500/10",
          spotlighted &&
            "ring-2 ring-violet-500/60 ring-offset-2 ring-offset-background"
        )}
      >
        <div className="flex items-center gap-1.5">
          <Clock className="h-3.5 w-3.5 shrink-0 text-pink-500" aria-hidden />
          <span className="min-w-0 flex-1 truncate text-xs font-semibold">
            {card.workflowName}
          </span>
          <ArrowRight
            className="h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
            aria-hidden
          />
        </div>
        <div className="mt-2 flex items-center justify-between text-[11px] text-muted-foreground">
          <span>every {fmtIntervalShort(card.scheduled.intervalMs)}</span>
          <span className="tabular-nums text-pink-600 dark:text-pink-400">
            next {fmtIn(card.scheduled.nextRunAt)}
          </span>
        </div>
        {card.scheduled.lastRunAt ? (
          <p className="mt-1 text-[10px] text-muted-foreground/70">
            last run {fmtRel(card.scheduled.lastRunAt)}
          </p>
        ) : null}
      </button>
    );
  }

  // v24: server-lane card — cyan accent + ⇉ badge, shows DB-side progress.
  if (card.server) {
    const s = card.server;
    return (
      <button
        type="button"
        onClick={() => onSelect(card.workflowId)}
        data-wf-card={card.workflowId}
        className={cn(
          "group w-full rounded-xl border border-cyan-500/30 bg-card/80 p-3 text-left shadow-sm transition-all duration-200",
          "hover:-translate-y-0.5 hover:border-cyan-500/60 hover:shadow-md hover:shadow-cyan-500/10",
          spotlighted && "ring-2 ring-violet-500/60 ring-offset-2 ring-offset-background"
        )}
      >
        <div className="flex items-center gap-1.5">
          {s.status === "running" ? (
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-violet-400" aria-hidden />
          ) : s.status === "error" ? (
            <X className="h-3.5 w-3.5 shrink-0 text-red-500" aria-hidden />
          ) : (
            <Check className="h-3.5 w-3.5 shrink-0 text-emerald-500" aria-hidden />
          )}
          <span className="min-w-0 flex-1 truncate text-xs font-semibold">{card.workflowName}</span>
          <span
            title="Fired headlessly by the local server while the tab was closed — built-in engine, results in the local DB"
            className="shrink-0 rounded-full border border-cyan-500/40 bg-cyan-500/10 px-1.5 py-0.5 text-[9px] font-semibold text-cyan-600 dark:text-cyan-400"
          >
            ⇉ server
          </span>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-muted-foreground">
          <span className="tabular-nums">{fmtRel(Date.parse(s.startedAt))}</span>
          <span>
            · {s.status === "running" ? `step ${s.currentStep}/${s.stepsTotal}` : `${s.stepsTotal} steps`}
          </span>
          <span>· {s.trigger === "manual" ? "manual" : "schedule"}</span>
        </div>
        {s.error ? (
          <p className="mt-1 line-clamp-2 break-words font-mono text-[10px] text-red-400">{s.error}</p>
        ) : null}
      </button>
    );
  }

  const run = card.run!;
  const reworks = run.steps.filter((s) => s.verdict === "rework" || s.reworked).length;
  const degraded = run.steps.filter((s) => s.degraded).length;
  const doneSteps = run.steps.filter((s) => s.status === "done").length;

  return (
    <button
      type="button"
      onClick={() => onSelect(card.workflowId, run.id)}
      data-wf-card={card.workflowId}
      className={cn(
        "card-in group w-full rounded-xl border bg-card/80 p-3 text-left shadow-sm transition-all duration-200",
        spotlighted &&
          "ring-2 ring-violet-500/60 ring-offset-2 ring-offset-background",
        "hover:-translate-y-0.5 hover:shadow-md",
        run.status === "running" &&
          "border-violet-500/30 hover:border-violet-500/60 hover:shadow-violet-500/10",
        run.status === "error" &&
          "border-red-500/30 hover:border-red-500/60 hover:shadow-red-500/10",
        run.status === "stopped" &&
          "border-amber-500/30 hover:border-amber-500/60 hover:shadow-amber-500/10",
        run.status === "done" &&
          "hover:border-emerald-500/60 hover:shadow-emerald-500/10"
      )}
    >
      <div className="flex items-center gap-1.5">
        {run.status === "running" ? (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-violet-400" aria-hidden />
        ) : run.status === "error" ? (
          <X className="h-3.5 w-3.5 shrink-0 text-red-500" aria-hidden />
        ) : run.status === "stopped" ? (
          <Ban className="h-3.5 w-3.5 shrink-0 text-amber-500" aria-hidden />
        ) : (
          <Check className="h-3.5 w-3.5 shrink-0 text-emerald-500" aria-hidden />
        )}
        <span className="min-w-0 flex-1 truncate text-xs font-semibold">
          {card.workflowName}
        </span>
        {run.novelty != null && (
          <span
            title={`Evolution novelty vs recent runs: ${run.novelty}%${run.novelty < 35 ? " — stall signal (near-duplicate output)" : ""}`}
            className={cn(
              "shrink-0 rounded-full border px-1.5 py-0.5 text-[9px] font-semibold tabular-nums",
              run.novelty < 35
                ? "border-amber-500/40 bg-amber-500/10 text-amber-500"
                : "border-emerald-500/30 bg-emerald-500/5 text-emerald-500"
            )}
          >
            🧬 {run.novelty}%
          </span>
        )}
        <ArrowRight
          className="h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
          aria-hidden
        />
      </div>

      <p className="mt-1.5 line-clamp-2 text-[11px] leading-snug text-muted-foreground">
        {run.task || "No task text"}
      </p>

      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-muted-foreground">
        <span className="tabular-nums">{fmtRel(run.startedAt)}</span>
        {run.finishedAt ? (
          <span className="tabular-nums">· {fmtMs(run.finishedAt - run.startedAt)}</span>
        ) : null}
        <span>
          · {run.status === "running" ? `${doneSteps}/${run.steps.length} steps` : `${run.steps.length} steps`}
        </span>
        {reworks > 0 ? (
          <span className="inline-flex items-center gap-0.5 rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 py-px font-semibold text-amber-600 dark:text-amber-400">
            <Undo2 className="h-2.5 w-2.5" aria-hidden />
            {reworks} rework{reworks === 1 ? "" : "s"}
          </span>
        ) : null}
        {degraded > 0 ? (
          <span
            title="Steps that hit their tool budget and ended on an auto-digest instead of a synthesized answer"
            className="inline-flex items-center rounded-full border border-orange-500/40 bg-orange-500/10 px-1.5 py-px font-semibold text-orange-600 dark:text-orange-400"
          >
            {degraded} auto-digest
          </span>
        ) : null}
      </div>
    </button>
  );
}

export function RunKanban({
  onSelect,
}: {
  onSelect: (workflowId: string, runId?: string) => void;
}) {
  const workflows = useWorkflowsStore((s) => s.workflows);
  const boardOpen = useUiStore((s) => s.workflowBoardOpen);
  const serverRuns = useServerRuns(boardOpen);
  // Keep countdowns honest
  const [, tick] = React.useReducer((n: number) => n + 1, 0);
  React.useEffect(() => {
    if (!boardOpen) return;
    const t = setInterval(tick, 30_000);
    return () => clearInterval(t);
  }, [boardOpen, tick]);

  const columns = React.useMemo(() => groupRuns(workflows, serverRuns), [workflows, serverRuns]);
  // Pipeline filter lives in the ui store (persisted): it survives layout
  // switches (grid <-> board) and reloads instead of resetting on unmount.
  const filter = useUiStore((s) => s.boardWorkflowFilter);
  const setFilter = useUiStore((s) => s.setBoardWorkflowFilter);
  const unfilteredTotal = Object.values(columns).reduce((n, c) => n + c.length, 0);
  const visible = React.useMemo(() => {
    if (!filter) return columns;
    const out = {} as Record<Column["id"], BoardCard[]>;
    (Object.keys(columns) as Column["id"][]).forEach((k) => {
      out[k] = columns[k].filter((c) => c.workflowId === filter);
    });
    return out;
  }, [columns, filter]);
  const total = Object.values(visible).reduce((n, c) => n + c.length, 0);
  // Chip choices: every pipeline that currently has at least one card, busiest first.
  const filterChoices = React.useMemo(() => {
    const counts = new Map<string, { name: string; n: number }>();
    (Object.keys(columns) as Column["id"][]).forEach((k) =>
      columns[k].forEach((c) => {
        const e = counts.get(c.workflowId) ?? { name: c.workflowName, n: 0 };
        e.n += 1;
        counts.set(c.workflowId, e);
      })
    );
    return [...counts.entries()].sort((a, b) => b[1].n - a[1].n);
  }, [columns]);

  if (unfilteredTotal === 0) {
    return (
      <div className="flex min-h-48 items-center justify-center rounded-2xl border border-dashed text-center text-sm text-muted-foreground">
        Nothing on the board yet — run a pipeline and its cards land here.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {filterChoices.length > 1 && (
        <div
          role="group"
          aria-label="Board filter by pipeline"
          className="flex flex-wrap items-center gap-1.5"
        >
          <button
            type="button"
            onClick={() => setFilter(null)}
            aria-pressed={filter === null}
            className={cn(
              "rounded-full border px-2.5 py-0.5 text-[10px] font-medium transition-colors",
              filter === null
                ? "border-violet-500/40 bg-violet-500/10 text-violet-600 dark:text-violet-400"
                : "border-border bg-muted/40 text-muted-foreground hover:text-foreground"
            )}
          >
            All pipelines
          </button>
          {filterChoices.map(([id, e]) => (
            <button
              key={id}
              type="button"
              onClick={() => setFilter(filter === id ? null : id)}
              aria-pressed={filter === id}
              title={`Show only cards from "${e.name}"`}
              className={cn(
                "max-w-52 truncate rounded-full border px-2.5 py-0.5 text-[10px] font-medium transition-colors",
                filter === id
                  ? "border-violet-500/40 bg-violet-500/10 text-violet-600 dark:text-violet-400"
                  : "border-border bg-muted/40 text-muted-foreground hover:text-foreground"
              )}
            >
              {e.name} <span className="tabular-nums opacity-70">{e.n}</span>
            </button>
          ))}
        </div>
      )}
      {filter && total === 0 ? (
        <div className="flex min-h-48 items-center justify-center rounded-2xl border border-dashed text-center text-sm text-muted-foreground">
          No cards match this filter — the selected pipeline has nothing on the board right now.
        </div>
      ) : (
      <div
        className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4"
        aria-label="Runs kanban board"
      >
      {COLUMNS.map((col) => {
        const cards = visible[col.id];
        return (
          <section
            key={col.id}
            aria-label={`${col.label} column, ${cards.length} card${cards.length === 1 ? "" : "s"}`}
            className={cn(
              "flex min-h-32 flex-col gap-2 rounded-2xl border border-t-4 bg-muted/20 p-2.5",
              col.ringClass
            )}
          >
            <header className="flex items-center gap-2 px-1 pt-0.5">
              <span className={cn("h-2 w-2 rounded-full", col.dotClass)} aria-hidden />
              <h3 className="text-xs font-semibold uppercase tracking-wide">
                {col.label}
              </h3>
              <span className="rounded-full bg-muted px-1.5 py-px text-[10px] font-semibold tabular-nums text-muted-foreground">
                {cards.length}
              </span>
              <span className="sr-only">{col.hint}</span>
            </header>
            <div className="flex flex-col gap-2">
              {cards.map((c) => (
                <RunCard key={c.key} card={c} onSelect={onSelect} />
              ))}
              {cards.length === 0 ? (
                <p className="px-1 py-3 text-[11px] leading-relaxed text-muted-foreground/70">
                  {col.id === "running" && "No runs streaming — start one from a pipeline card."}
                  {col.id === "attention" && "Nothing needs attention. 🎉"}
                  {col.id === "done" && "Finished runs will pile up here."}
                  {col.id === "scheduled" && "Enable a recurring schedule on a pipeline."}
                </p>
              ) : null}
            </div>
          </section>
        );
      })}
      </div>
      )}
    </div>
  );
}
