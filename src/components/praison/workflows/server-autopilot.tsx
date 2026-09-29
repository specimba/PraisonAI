"use client";

import * as React from "react";
import { Bot, CircleDot, RefreshCw, RadioTower, Server } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

// ─── v20: Server autopilot panel (Workflow Studio) ───────────────────────────
// Surfaces the headless layer: whether the local server or the open browser
// tab is currently driving scheduled runs, what is registered, and recent
// server-side runs with live step progress.

type RegistryRow = {
  id: string;
  name: string;
  intervalMs: number;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  failStreak: number;
};
type RunRow = {
  id: string;
  workflowName: string;
  trigger: string;
  status: string;
  currentStep: number;
  stepsTotal: number;
  finalReport: string | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
};
type SyncState = {
  serverDriving: boolean;
  lastSeenAt: string | null;
  registry: RegistryRow[];
  runs: RunRow[];
};

const POLL_MS = 15_000;

function fmtIn(iso: string | null): string {
  if (!iso) return "—";
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "due";
  const m = Math.round(ms / 60_000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  return `${(m / 60).toFixed(1)}h`;
}

function fmtAgo(iso: string | null): string {
  if (!iso) return "never";
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${(m / 60).toFixed(1)}h ago`;
}

export function ServerAutopilot() {
  const [state, setState] = React.useState<SyncState | null>(null);
  const [openRun, setOpenRun] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);

  const poll = React.useCallback(async () => {
    try {
      const res = await fetch("/api/automation/sync", { cache: "no-store" });
      if (res.ok) setState((await res.json()) as SyncState);
    } catch {
      /* local server briefly unreachable — retry next tick */
    }
  }, []);

  React.useEffect(() => {
    void poll();
    const t = setInterval(poll, POLL_MS);
    return () => clearInterval(t);
  }, [poll]);

  async function runNow(id: string, name: string) {
    setBusy(id);
    try {
      const res = await fetch("/api/automation/run-now", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workflowId: id }),
      });
      const json = (await res.json()) as { ok?: boolean; error?: string };
      if (json.ok) {
        toast.success("Queued on the local server", {
          description: `${name} — the autopilot picks it up within 30s.`,
        });
        void poll();
      } else {
        toast.error("Run-now failed", { description: json.error ?? "unknown error" });
      }
    } finally {
      setBusy(null);
    }
  }

  const driving = state?.serverDriving === true;
  const active = state?.registry.filter((r) => r.enabled) ?? [];

  return (
    <section
      aria-label="Server autopilot"
      className="rounded-xl border border-sky-500/25 bg-sky-500/[0.04] p-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <RadioTower className="h-4 w-4 shrink-0 text-sky-400" aria-hidden />
        <h3 className="text-sm font-semibold leading-none">Server autopilot</h3>
        <Badge
          variant="outline"
          className={cn(
            "px-1.5 py-0 text-[10px]",
            driving
              ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-400"
              : "border-violet-500/40 bg-violet-500/10 text-violet-300"
          )}
        >
          {driving ? (
            <>
              <CircleDot className="mr-1 h-2.5 w-2.5 animate-pulse" aria-hidden />
              server driving — tab closed/idle
            </>
          ) : (
            <>
              <CircleDot className="mr-1 h-2.5 w-2.5" aria-hidden />
              browser driving — schedules run in-tab (your keys)
            </>
          )}
        </Badge>
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto h-7 px-2 text-xs"
          onClick={() => void poll()}
        >
          <RefreshCw className="h-3 w-3" aria-hidden />
          Refresh
        </Button>
      </div>
      <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
        While the tab is open, schedules run in-browser with your own keys (BYOK — nothing
        leaves this machine). When the tab is closed, the local server fires the same
        schedules headlessly via the built-in engine and results land here. Local-only: no
        telemetry, no cloud relay.
      </p>

      {active.length > 0 ? (
        <ul className="mt-2.5 space-y-1">
          {active.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
              <span className="font-medium">{r.name}</span>
              <span className="text-muted-foreground">
                every {Math.max(1, Math.round(r.intervalMs / 60_000))}m · next {fmtIn(r.nextRunAt)}
                {r.failStreak > 0 ? ` · ⚠ ${r.failStreak} fail${r.failStreak === 1 ? "" : "s"}` : ""}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={busy === r.id}
                onClick={() => void runNow(r.id, r.name)}
                className="ml-auto h-6 gap-1 px-1.5 text-[10px]"
                title="Fire this pipeline on the local server now (headless lane)"
              >
                <Server className="h-3 w-3" aria-hidden />
                Run on server
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2.5 text-xs text-muted-foreground">
          No schedules registered yet — enable a recurring schedule on any pipeline and it
          syncs here within a minute.
        </p>
      )}

      {state && state.runs.length > 0 ? (
        <div className="mt-3 border-t border-sky-500/15 pt-2.5">
          <p className="text-[11px] font-medium text-muted-foreground">
            Recent server runs (last {state.runs.length})
          </p>
          <ul className="mt-1.5 max-h-64 space-y-1.5 overflow-y-auto pr-1">
            {state.runs.map((r) => {
              const expanded = openRun === r.id;
              return (
                <li key={r.id} className="text-xs">
                  <button
                    type="button"
                    onClick={() => setOpenRun(expanded ? null : r.id)}
                    className="flex w-full flex-wrap items-center gap-x-2 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-accent/60"
                    aria-expanded={expanded}
                  >
                    <span
                      className={cn(
                        "font-semibold",
                        r.status === "done"
                          ? "text-emerald-500"
                          : r.status === "error"
                            ? "text-red-400"
                            : "text-violet-400"
                      )}
                    >
                      {r.status === "running"
                        ? `⟳ step ${r.currentStep}/${r.stepsTotal}`
                        : r.status === "done"
                          ? "✓ done"
                          : "✗ error"}
                    </span>
                    <span className="font-medium">{r.workflowName}</span>
                    <span className="text-muted-foreground">
                      {r.trigger === "manual" ? "manual" : "schedule"} · {fmtAgo(r.startedAt)}
                    </span>
                  </button>
                  {expanded ? (
                    <div className="mx-1.5 mt-1 rounded-md border bg-background/60 p-2">
                      {r.error ? (
                        <p className="break-words font-mono text-[10.5px] text-red-400">{r.error}</p>
                      ) : null}
                      {r.finalReport ? (
                        <p className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[10.5px] leading-relaxed text-muted-foreground">
                          {r.finalReport.slice(0, 4_000)}
                          {r.finalReport.length > 4_000 ? " …" : ""}
                        </p>
                      ) : !r.error ? (
                        <p className="text-[10.5px] text-muted-foreground">No output yet.</p>
                      ) : null}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      ) : (
        <p className="mt-2.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Bot className="h-3 w-3" aria-hidden />
          No server runs yet — they appear here after the first closed-tab fire (or a
          &ldquo;Run on server&rdquo; click).
        </p>
      )}
    </section>
  );
}
