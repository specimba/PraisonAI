"use client";

import * as React from "react";
import {
  Bot,
  CircleDot,
  Clock,
  KeyRound,
  RefreshCw,
  RadioTower,
  Server,
  Timer,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { useUiStore, useWorkflowsStore } from "@/lib/stores";
import { cn } from "@/lib/utils";

// r116: transient = environmental noise (429 congestion, socket blips, the app
// restarting mid-dial). Mirrors the scheduler's TRANSIENT_RE + RATE_LIMIT_RE —
// these render as amber "↻ retried", NOT the terminal red "✗ error".
const TRANSIENT_RE = /\b(429|too many requests|rate.?limit|socket connection|econnreset|econnrefused|fetch failed|network|premature close|terminated|etimeout|timeout)\b/i;

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
type VaultLaneState = {
  hasKey: boolean;
  maskedKey: string | null;
  updatedAt: string | null;
};
type SyncState = {
  serverDriving: boolean;
  lastSeenAt: string | null;
  registry: RegistryRow[];
  runs: RunRow[];
  // r134: the sync GET reports the AutomationVault lane so the panel shows
  // WHAT closed-tab runs will dial with — the user's stored key (masked) or
  // the shared built-in gateway. Optional: tolerant of older responses.
  vaultLane?: VaultLaneState;
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
  // r137: the heartbeat timestamp can land a hair AFTER this tab's clock
  // (server write vs client read skew) — the panel rendered "-5s ago" live.
  // Anything under 10s is "just now"; never render a negative duration.
  if (s < 10) return "just now";
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
  // r137: lane-true countdowns. The DB registry's nextRunAt only advances
  // when the EXTERNAL scheduler claims a due run — while the tab drives
  // (BYOK), it goes stale-past and the panel showed "due" on pipelines that
  // had run minutes ago (seen live 2026-09-30). The tab's own
  // schedule.nextRunAt is the truth for the active lane; the registry is the
  // truth once the server lane is driving.
  const workflows = useWorkflowsStore((s) => s.workflows);
  const localNextByWf = React.useMemo(() => {
    const m = new Map<string, string>();
    for (const w of workflows) {
      if (
        w.schedule?.enabled === true &&
        w.steps.length > 0 &&
        typeof w.schedule.nextRunAt === "number"
      ) {
        m.set(w.id, new Date(w.schedule.nextRunAt).toISOString());
      }
    }
    return m;
  }, [workflows]);
  const registryNextFire =
    active
      .map((r) => r.nextRunAt)
      .filter((v): v is string => typeof v === "string")
      .sort()[0] ?? null;
  const localNextFire = !driving
    ? ([...localNextByWf.values()].sort()[0] ?? null)
    : null;
  const nextFire = localNextFire ?? registryNextFire;
  const vaultKeyMasked =
    state?.vaultLane?.hasKey === true ? (state.vaultLane.maskedKey ?? null) : null;
  // r134: chip deep-links to the vault card (same r125 pattern the workflow
  // cards use) so the fix for a missing key is one click away.
  const openVault = React.useCallback(() => {
    useUiStore.getState().setView("settings");
    useUiStore.getState().setSettingsAnchor("vault");
  }, []);

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
        <span
          title={
            driving
              ? "Last time the open tab synced its schedules; it went quiet and the server lane took over."
              : "Last time the open tab synced schedules + keys to the local server (every 60s)."
          }
          className={cn(
            "inline-flex items-center gap-1 rounded-full border px-1.5 py-0 text-[10px] transition-colors",
            driving
              ? "border-amber-500/40 bg-amber-500/10 text-amber-300"
              : "border-sky-500/40 bg-sky-500/10 text-sky-300"
          )}
        >
          <Clock className="h-2.5 w-2.5" aria-hidden />
          {driving ? "bridge silent" : "bridge sync"} {fmtAgo(state?.lastSeenAt ?? null)}
        </span>
        {nextFire ? (
          <span
            title={
              driving
                ? "Soonest scheduled fire across all registered pipelines (headless-lane claim view)"
                : "Soonest fire among this tab's enabled schedules (the active BYOK lane)"
            }
            className="inline-flex items-center gap-1 rounded-full border border-sky-500/25 bg-sky-500/[0.06] px-1.5 py-0 text-[10px] text-sky-200/90 transition-colors hover:border-sky-500/40"
          >
            <Timer className="h-2.5 w-2.5" aria-hidden />
            next fire {fmtIn(nextFire)}
          </span>
        ) : null}
        {state ? (
          <button
            type="button"
            onClick={openVault}
            title={
              vaultKeyMasked
                ? `Closed-tab runs dial with your stored key ${vaultKeyMasked} (Automation vault). Click to manage.`
                : "Closed-tab runs share the built-in gateway (rate-limited). Click to store a vault key."
            }
            aria-label="Headless lane key status"
            className={cn(
              "inline-flex items-center gap-1 rounded-full border px-1.5 py-0 text-[10px] transition-colors",
              vaultKeyMasked
                ? "border-cyan-500/40 bg-cyan-500/10 text-cyan-300 hover:border-cyan-500/60 hover:bg-cyan-500/15"
                : "border-amber-500/40 bg-amber-500/10 text-amber-300 hover:border-amber-500/60 hover:bg-amber-500/15"
            )}
          >
            <KeyRound className="h-2.5 w-2.5" aria-hidden />
            {vaultKeyMasked
              ? `headless lane: your key ${vaultKeyMasked}`
              : "headless lane: shared lane"}
          </button>
        ) : null}
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto h-7 px-2 text-xs transition-colors hover:text-sky-300"
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
                every {Math.max(1, Math.round(r.intervalMs / 60_000))}m · next{" "}
                {fmtIn(localNextByWf.get(r.id) ?? r.nextRunAt)}
                {r.failStreak > 0 ? ` · ⚠ ${r.failStreak} fail${r.failStreak === 1 ? "" : "s"}` : ""}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={busy === r.id}
                onClick={() => void runNow(r.id, r.name)}
                className="ml-auto h-6 gap-1 border-sky-500/30 px-1.5 text-[10px] text-sky-300/90 transition-colors hover:bg-sky-500/10 hover:text-sky-200"
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
              // r116: mirror of the scheduler's TRANSIENT_RE — infra blips
              // (429/socket/restart-window noise) render as an amber
              // "↻ retried" (schedule survived, backoff armed) instead of
              // the red terminal "✗ error" reserved for hard failures.
              const transient = r.status === "error" && TRANSIENT_RE.test(r.error ?? "");
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
                          : transient
                            ? "text-amber-400"
                            : r.status === "error"
                              ? "text-red-400"
                              : "text-violet-400"
                      )}
                    >
                      {r.status === "running"
                        ? `⟳ step ${r.currentStep}/${r.stepsTotal}`
                        : r.status === "done"
                          ? "✓ done"
                          : transient
                            ? "↻ retried"
                            : "✗ error"}
                    </span>
                    <span className="font-medium">{r.workflowName}</span>
                    <span className="text-muted-foreground">
                      {r.trigger === "manual" ? "manual" : "schedule"} · {fmtAgo(r.startedAt)}
                    </span>
                  </button>
                  {expanded ? (
                    <div className="mx-1.5 mt-1 rounded-md border bg-background/60 p-2">
                      {transient ? (
                        <p className="mb-1 text-[10.5px] font-medium text-amber-400">
                          Transient infra error — schedule stays enabled, retry backoff armed.
                        </p>
                      ) : null}
                      {r.error ? (
                        <p className={cn("break-words font-mono text-[10.5px]", transient ? "text-amber-400/80" : "text-red-400")}>{r.error}</p>
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
