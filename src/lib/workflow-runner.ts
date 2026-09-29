"use client";

// ─── Shared workflow run engine (used by the run panel AND the scheduler) ────

import { toast } from "sonner";
import { runText, scoreNovelty } from "@/lib/evolution";
import { maybeProposeSpawn, NOVELTY_SPAWN_THRESHOLD } from "@/lib/spawn-proposal-engine";
import { isAbortError, runAgentChat } from "@/lib/chat-client";
import { resolveLlm } from "@/lib/llm-config";
import { decide, SYSTEMONE_GATE_CONFIDENCE } from "@/lib/systemone";
import { buildRelayWire, recordRelayHopResult, type RelayTaskFit, type RelayWireHop } from "@/lib/relay";
import {
  buildConversationalContext,
  buildReviewContext,
  buildSequentialContext,
  parseReviewVerdict,
  uid,
  type PrevStepOutput,
} from "@/lib/helpers";
import {
  useAgentsStore,
  useSettingsStore,
  useUiStore,
  useWorkflowsStore,
} from "@/lib/stores";
import { REWORK_LIMIT } from "@/lib/constants";
import type {
  Agent,
  PipelineDepth,
  RunCallLogEntry,
  RunErrorInfo,
  RunErrorKind,
  ToolCallInfo,
  ToolId,
  Workflow,
  WorkflowRun,
  WorkflowRunStep,
} from "@/lib/types";

/** Workflows with a run currently streaming — guards concurrent triggers. */
const activeRuns = new Set<string>();

// ─── Run liveness (r71): every run is guaranteed to reach a terminal state ──
// A streaming fetch can hang forever (provider drops the connection without
// closing it, laptop sleep, heavy background-tab throttling) and the run row
// would sit at "running" for eternity. The watchdog aborts any active run
// with no store activity for STALL_TIMEOUT_MS; the run then finalizes as a
// RESUMABLE timeout error — never a silent hang.
const activeControllers = new Map<string, AbortController>();
const lastRunActivity = new Map<string, number>();
const stalledRuns = new Set<string>();
/** Stall watchdog threshold — runtime-tunable (r75): set localStorage
 * "praison-stall-timeout-ms" and reload; clamped 20s–10min so an E2E can
 * force stalls in seconds WITHOUT a rebuild, while production keeps 4min.
 * Read live per watchdog tick (one localStorage read per tick). */
function stallTimeoutMs(): number {
  const DEF = 4 * 60_000;
  try {
    const raw = localStorage.getItem("praison-stall-timeout-ms");
    if (!raw) return DEF;
    const n = Number(raw);
    return Number.isFinite(n) ? Math.min(Math.max(Math.floor(n), 20_000), 600_000) : DEF;
  } catch {
    return DEF;
  }
}
/** Human label for timeout messages, so tuned timeouts don't lie in the UI. */
function stallTimeoutLabel(): string {
  const ms = stallTimeoutMs();
  return ms >= 60_000 ? `${Math.round(ms / 60_000)} minutes` : `${Math.round(ms / 1000)} seconds`;
}
/** Bounded self-recovery (r72): a watchdog-stalled run auto-resumes from its
 * failed step up to MAX_AUTO_RESUMES times (shared budget with manual resumes
 * — both bump resumeCount) before falling back to the manual-resume card. */
import { clearWorkerInterval, setWorkerInterval, setWorkerTimeout } from "@/lib/worker-timer";

const MAX_AUTO_RESUMES = 3;
const STALL_CHECK_MS = 15_000;
const STALL_WATCHDOG_KEY = "praison-stall-watchdog";
let stallWatchdog: ReturnType<typeof setInterval> | null = null;

/** Live controller for a workflow's active run — lets the UI re-acquire Stop after a remount. */
export function getRunController(workflowId: string): AbortController | undefined {
  return activeControllers.get(workflowId);
}

function stopStallWatchdog(): void {
  clearWorkerInterval(STALL_WATCHDOG_KEY);
  if (stallWatchdog != null) {
    clearInterval(stallWatchdog);
    stallWatchdog = null;
  }
}

function ensureStallWatchdog(): void {
  if (stallWatchdog) return;
  const tick = () => {
    const now = Date.now();
    for (const wfId of [...activeRuns]) {
      if (now - (lastRunActivity.get(wfId) ?? 0) > stallTimeoutMs()) {
        // Mark + abort: the pending fetch rejects with an AbortError, the
        // runner's abort handlers check stalledRuns and finalize as timeout.
        stalledRuns.add(wfId);
        activeControllers
          .get(wfId)
          ?.abort(
            new Error(
              `no model output for over ${stallTimeoutLabel()} — the stream stalled`
            )
          );
      }
    }
    if (activeRuns.size === 0) {
      stopStallWatchdog();
    }
  };
  const ms = Math.min(STALL_CHECK_MS, Math.floor(stallTimeoutMs() / 4));
  // v20: run the cadence on the worker clock when possible — background tabs
  // clamp main-thread timers to ~1/min (intensive throttling), which turned
  // stall detection into multi-minute hangs. Fallback keeps old behavior.
  if (!setWorkerInterval(STALL_WATCHDOG_KEY, ms, tick)) {
    stallWatchdog = setInterval(tick, ms);
  }
}

export function isWorkflowRunning(workflowId: string): boolean {
  return activeRuns.has(workflowId);
}

export function activeRunCount(): number {
  return activeRuns.size;
}

/**
 * Bounded stall self-recovery (r72): ~1.2s after a watchdog-aborted run has
 * been finalized, re-enter executeWorkflowRun through the normal resume path
 * (completed steps preserved, execution restarts at the failed step).
 * The delay is load-bearing: the dying invocation's `finally` wipes the module
 * registries (activeRuns/activeControllers) and the resumed call re-registers
 * them SYNCHRONOUSLY — firing immediately would let that finally delete the
 * NEW registration. Guarded re-entry: skipped when the run vanished, a user
 * already resumed/stopped it, or another run holds the engine.
 */
function scheduleAutoResume(
  workflowId: string,
  runId: string,
  fromStepIndex: number,
  previousResumes: number
): void {
  const fireAutoResume = () => {
    const wf = useWorkflowsStore
      .getState()
      .workflows.find((w) => w.id === workflowId);
    const run = wf?.runs.find((r) => r.id === runId);
    if (!wf || !run || run.status === "running") return; // user resumed/stopped
    if (activeRuns.has(workflowId)) return; // engine busy with another run
    toast("Stall auto-recovery engaged", {
      icon: "⏱️",
      description: `"${run.steps[fromStepIndex]?.label ?? "Failed step"}" went silent for 4+ minutes — resuming "${wf.name}" from there (auto-resume ${previousResumes + 1}/${MAX_AUTO_RESUMES}, completed steps preserved).`,
    });
    executeWorkflowRun({
      workflow: wf,
      resume: { runId, fromStepIndex },
      source: "scheduled",
    }).catch((err) => {
      // v23: a rejected auto-resume used to surface as an unhandled rejection
      // ("Runtime Error: undefined"). The runner is resolve-only now; this
      // guard is the belt to those suspenders.
      console.error("[workflow-runner] auto-resume failed", err);
    });
  };
  // v20: worker-clock delay — a backgrounded tab clamps main-thread timers,
  // which stretched the 1.2s re-entry into minutes right after a stall abort.
  if (!setWorkerTimeout(`auto-resume-${runId}`, 1200, fireAutoResume)) {
    setTimeout(fireAutoResume, 1200);
  }
}

export interface ExecuteRunOptions {
  workflow: Pick<Workflow, "id">;
  task: string;
  /** "scheduled" runs toast with a clock icon and a distinct message. */
  source?: "manual" | "scheduled";
  /** Called right after the run row is created (panel uses it to view + wire Stop). */
  onStarted?: (runId: string, controller: AbortController) => void;
  /** Called with the final status whether done, stopped or errored. */
  onSettled?: (runId: string, status: WorkflowRun["status"]) => void;
  /** Optional external stop handle — defaults to the runner's own controller. */
  signal?: AbortSignal;
  /**
   * v11 "Retry via relay": when true, every model call in this execution skips
   * the browser-direct lane and runs through the server relay (/api/chat).
   * Recovery-card escape hatch for steps whose DIRECT lane died mid-stream
   * (sawTokens deaths rethrow by design — the auto-fallback only covers
   * pre-stream failures), or whose direct provider is otherwise unusable.
   */
  forceServer?: boolean;
  /**
   * Resume an existing errored/stopped run instead of creating a new row:
   * completed step outputs are preserved, execution restarts at fromStepIndex.
   * When set, `task` is ignored (the run's original task is reused).
   */
  resume?: { runId: string; fromStepIndex: number };
}

// ─── Failure classification (powers the non-silent recovery card) ───────────

const ERROR_KIND_META: Record<RunErrorKind, { label: string; hint: string }> = {
  network: {
    label: "Network",
    hint: "The connection to the model provider dropped mid-run. This is usually transient — retrying the failed step keeps every completed step's output.",
  },
  region: {
    label: "Region block",
    hint: "The provider refuses datacenter IPs — this is a network-location block, NOT a key problem. Browser-direct mode (on by default) calls from your own network and avoids it; if you still see this, the relay already rotated to another lane — retry the step.",
  },
  auth: {
    label: "Auth",
    hint: "The API key was rejected (expired, revoked or wrong). Fix the key in Settings → Free frontier providers, then retry the failed step.",
  },
  "rate-limit": {
    label: "Rate limit",
    hint: "The provider's free-tier quota tripped (429). Wait a minute — or switch to another free provider in the header picker — then retry the failed step.",
  },
  timeout: {
    label: "Timeout",
    hint: "The provider took too long to answer. Retry usually helps; if it keeps happening, try a smaller/faster model for this step.",
  },
  model: {
    label: "Model",
    hint: "The model id no longer exists on this provider (renamed or decommissioned). Open Settings → the provider card → “Refresh models” to pull the current roster, pick a live model, then retry. The relay already skipped past it.",
  },
  unknown: {
    label: "Unknown",
    hint: "The provider returned an error we couldn't classify. Copy the diagnostics below for details — retrying the failed step is still safe.",
  },
};

const ERROR_PATTERNS: { kind: RunErrorKind; re: RegExp }[] = [
  { kind: "rate-limit", re: /\b429\b|rate.?limit|quota|too many requests/i },
  {
    // BEFORE auth: a 403 with block-page signatures is a location block, not
    // a key problem — "Access forbidden (check key/region)" alone stays auth.
    kind: "region",
    re: /blocked this network|region\/?IP block|datacenter|server-region|\b451\b/i,
  },
  { kind: "auth", re: /\b(401|403)\b|unauthorized|invalid.{0,12}(api )?key|invalid.?key|forbidden|permission denied/i },
  { kind: "model", re: /\b404\b|no such model|model.?not.?found|model (.{0,40} )?does not exist|model_not_found|endpoint not found|decommissioned|does not exist or is not supported/i },
  { kind: "timeout", re: /timeout|timed? ?out|etimedout|deadline/i },
  {
    kind: "network",
    re: /network|fetch failed|failed to fetch|could not reach|socket|econn|enotfound|eai_again|dns|connection (refused|reset|closed|error)|load failed|premature close|stream ended without|upstream|http 5\d\d|bad gateway|service unavailable/i,
  },
];

/** Failure kinds the runner heals by itself (one automatic step retry). */
const SELF_HEAL_KINDS: RunErrorKind[] = ["network", "timeout", "rate-limit"];

/** Classify an engine error message → kind + copy used by the recovery card. */
export function classifyRunError(message: string): {
  kind: RunErrorKind;
  hint: string;
} {
  for (const { kind, re } of ERROR_PATTERNS) {
    if (re.test(message)) return { kind, hint: ERROR_KIND_META[kind].hint };
  }
  return { kind: "unknown", hint: ERROR_KIND_META.unknown.hint };
}

export function runErrorKindLabel(kind: RunErrorKind): string {
  return ERROR_KIND_META[kind].label;
}

// ─── Pipeline depth (r26): synthetic passes injected at materialization ──────

const DEEP_RESEARCH_INSTRUCTION =
  "This is a DEEP-RESEARCH pass. Search for information that previous passes did not cover: " +
  "different sources, missing numbers, contradicting viewpoints, primary sources. Verify the " +
  "key claims you see in the conversation context and correct them.";

const VERIFICATION_INSTRUCTION =
  "VERIFICATION PASS (final pipeline step — your reply IS the deliverable): silently check the " +
  "conversation context for unsupported claims, missing citations, and gaps. Use the tools " +
  "available (web_search / arxiv_search) to verify load-bearing facts where needed. Then output " +
  "the FULL corrected, tightened version of the previous step's output — never a plan, never an " +
  "announcement of what you are about to do, never a summary of changes alone. If you called " +
  "tools, continue after their results and still deliver the complete final output in this same " +
  "reply. End with a one-line 'Verification:' note listing what you checked.";

const DEEP_PASSES: { n: 2 | 3; label: string }[] = [
  { n: 2, label: "Deep research pass 2 — verify & broaden" },
  { n: 3, label: "Deep research pass 3 — cross-check sources" },
];

/**
 * Fresh-run step materialization with depth control (r26).
 * - quick:    exactly as authored (no injection)
 * - standard: + one synthetic "Verification & synthesis" pass at the end when
 *             the pipeline has NO review-gate step (a real review gate already
 *             provides verification semantics)
 * - deep:     + 2 deep-research passes cloned from the FIRST step's agent
 *             (inserted right after it), then the same verification pass
 *             Missing depth reads as "standard" (pre-r26 workflows keep working).
 *
 * Resume is deliberately NOT routed through here: resumed runs re-use their
 * already-materialized step rows, so old runs stay byte-identical.
 */
export function materializeRunSteps(wf: Workflow, agentsNow: Agent[]): WorkflowRunStep[] {
  const base: WorkflowRunStep[] = wf.steps.map((s) => {
    const agent = agentsNow.find((a) => a.id === s.agentId);
    return {
      stepId: s.id,
      agentId: s.agentId,
      agentName: agent?.name ?? "Unknown agent",
      agentEmoji: agent?.emoji ?? "🤖",
      label: s.label || "Untitled step",
      output: "",
      toolCalls: [],
      // r80: honest queue state — the engine loop flips the executing step to
      // "running" via its start-of-step patch (workflow-runner line ~772).
      status: "pending" as const,
      kind: s.kind ?? "generate",
    };
  });

  const depth: PipelineDepth = wf.depth ?? "standard";
  if (depth === "quick" || base.length === 0) return base;

  let steps = base;

  // Deep: clone the FIRST step's agent into 2 extra research passes.
  if (depth === "deep") {
    const first = steps[0];
    const firstAgent = agentsNow.find((a) => a.id === first.agentId);
    // arXiv fits research — grant the merged tool set only when the base agent
    // already has any tools (an agent authored without tools stays tool-free).
    const baseTools = firstAgent?.tools ?? [];
    const passTools: ToolId[] | undefined =
      baseTools.length > 0
        ? Array.from(new Set<ToolId>([...baseTools, "web_search", "arxiv_search"]))
        : undefined;
    const passes: WorkflowRunStep[] = DEEP_PASSES.map(({ label }) => ({
      stepId: uid("deep"),
      agentId: first.agentId,
      agentName: firstAgent?.name ?? first.agentName,
      agentEmoji: firstAgent?.emoji ?? first.agentEmoji,
      label,
      output: "",
      toolCalls: [],
      status: "pending" as const,
      kind: "generate" as const,
      instruction: DEEP_RESEARCH_INSTRUCTION,
      ...(passTools ? { tools: passTools } : {}),
    }));
    steps = [first, ...passes, ...steps.slice(1)];
  }

  // Standard + deep: synthetic verification pass when no review gate exists.
  const hasReviewSemantics = steps.some((s) => s.kind === "review");
  if (!hasReviewSemantics) {
    const last = steps[steps.length - 1];
    const lastAgent = agentsNow.find((a) => a.id === last.agentId);
    steps = [
      ...steps,
      {
        stepId: uid("verify"),
        agentId: last.agentId,
        agentName: lastAgent?.name ?? last.agentName,
        agentEmoji: lastAgent?.emoji ?? last.agentEmoji,
        label: "Verification & synthesis",
        output: "",
        toolCalls: [],
        status: "pending" as const,
        kind: "generate" as const,
        instruction: VERIFICATION_INSTRUCTION,
      },
    ];
  }
  return steps;
}

/**
 * Run a workflow pipeline end-to-end: creates the run row in the store,
 * streams each step through the agent chain, patches statuses live.
 * Steps marked kind:"review" act as quality gates — they audit the previous
 * step's output and may send it back for a rework pass (up to REWORK_LIMIT).
 * With `options.resume` it continues an existing errored/stopped run from a
 * step index, preserving every completed step's output (non-destructive).
 * Returns the run id, or null when the run could not start.
 */
export async function executeWorkflowRun(
  options: ExecuteRunOptions
): Promise<string | null> {
  const { source = "manual", onStarted, onSettled } = options;
  // v11: recovery-card "Retry via relay" escape hatch (see ExecuteRunOptions).
  const forceServer = options.forceServer === true;
  const wf = useWorkflowsStore
    .getState()
    .workflows.find((w) => w.id === options.workflow.id);
  if (!wf || wf.steps.length === 0) return null;
  if (activeRuns.has(wf.id)) return null;

  const store = useWorkflowsStore.getState();
  const settings = useSettingsStore.getState();
  const agentsNow = useAgentsStore.getState().agents;

  // ─── Fresh run vs resume of an existing errored/stopped row ─────────────
  let runId: string;
  let task: string;
  let steps: WorkflowRunStep[];
  let startIndex = 0;
  let attempts = 0;

  if (options.resume) {
    const run = wf.runs.find((r) => r.id === options.resume!.runId);
    if (!run || run.status === "running") return null;
    runId = run.id;
    task = run.task;
    attempts = run.error?.attempts ?? 0;
    startIndex = Math.min(
      Math.max(0, options.resume.fromStepIndex),
      run.steps.length - 1
    );
    // r80: resumed tail steps start "pending" — the engine loop flips the
    // resumed-from step to "running" at its start-of-step patch.
    steps = run.steps.map((s, i) =>
      i >= startIndex
        ? { ...s, output: "", toolCalls: [], status: "pending" as const, ms: undefined, verdict: undefined, reworked: undefined }
        : s
    );
    store.patchRun(wf.id, runId, {
      status: "running",
      finishedAt: undefined,
      error: undefined,
      steps,
      resumeCount: (run.resumeCount ?? 0) + 1,
    });
  } else {
    if (options.task.trim() === "") return null;
    runId = uid("run");
    task = options.task.trim();
    // r26 depth control: quick = as authored · standard = + verification pass ·
    // deep = + 2 research passes + verification. Resume (above) is untouched.
    steps = materializeRunSteps(wf, agentsNow);
    store.addRun(wf.id, {
      id: runId,
      workflowId: wf.id,
      workflowName: wf.name,
      task,
      status: "running",
      startedAt: Date.now(),
      steps,
    });
  }

  const controller = new AbortController();
  const signal = options.signal ?? controller.signal;
  activeRuns.add(wf.id);
  activeControllers.set(wf.id, controller);
  lastRunActivity.set(wf.id, Date.now());
  ensureStallWatchdog();
  useUiStore.getState().setBusy(true);
  onStarted?.(runId, controller);

  const patchRunStep = (
    stepId: string,
    patch: Partial<WorkflowRunStep>
  ) => {
    lastRunActivity.set(wf.id, Date.now());
    useWorkflowsStore.getState().patchRunStep(wf.id, runId, stepId, patch);
  };
  const patchRun = (patch: Partial<WorkflowRun>) => {
    lastRunActivity.set(wf.id, Date.now());
    useWorkflowsStore.getState().patchRun(wf.id, runId, patch);
  };

  /** Append one LLM-call record to the run's call log (harness rank-② slice). */
  const pushCall = (entry: Omit<RunCallLogEntry, "at">) => {
    try {
      const run = useWorkflowsStore
        .getState()
        .workflows.find((w) => w.id === wf.id)
        ?.runs.find((r) => r.id === runId);
      const log = [...(run?.callLog ?? []), { at: Date.now(), ...entry } as RunCallLogEntry].slice(-60);
      patchRun({ callLog: log });
    } catch {
      /* logging must never break a run */
    }
  };

  const stopRemaining = (fromIndex: number) => {
    for (let j = fromIndex + 1; j < steps.length; j++) {
      patchRunStep(steps[j].stepId, { status: "stopped", output: "" });
    }
  };

  // v23: idempotency flag — the escaped-error outer catch may finalize after a
  // partial finish(); never double-patch or double-toast.
  let finalized = false;
  const finish = (
    status: WorkflowRun["status"],
    toastMsg: string,
    errorInfo?: RunErrorInfo
  ) => {
    if (finalized) return;
    finalized = true;
    // Evolution Layer (r68): novelty % vs this workflow's recent done runs —
    // best-effort; a scoring failure must never affect run finalization.
    let novelty: number | undefined;
    if (status === "done") {
      try {
        const liveWf = useWorkflowsStore.getState().workflows.find((w) => w.id === wf.id);
        const prevOutputs = (liveWf?.runs ?? [])
          .filter((r) => r.id !== runId && r.status === "done")
          .map((r) => runText(r.steps));
        const score = scoreNovelty(runText(steps), prevOutputs);
        if (score != null) novelty = score;
      } catch {
        /* novelty is best-effort */
      }
    }
    // Evolution Layer (r70): a done run with low novelty = the pipeline keeps
    // producing near-duplicates. Best-effort: propose a variation to the
    // spawn inbox (max ONE open proposal per source workflow — anti-spam).
    // Threshold is user-configurable (Settings → Evolution); read best-effort
    // so a settings-store failure can never affect run finalization.
    const spawnThreshold = (() => {
      try {
        return (
          useSettingsStore.getState().settings.noveltySpawnThreshold ??
          NOVELTY_SPAWN_THRESHOLD
        );
      } catch {
        return NOVELTY_SPAWN_THRESHOLD;
      }
    })();
    if (
      status === "done" &&
      novelty !== undefined &&
      novelty < spawnThreshold
    ) {
      try {
        const st = useWorkflowsStore.getState();
        const openSourceIds = st.proposals
          .filter((p) => p.status === "open")
          .map((p) => p.sourceWorkflowId);
        const liveWf2 = st.workflows.find((w) => w.id === wf.id);
        const taskExcerpt =
          liveWf2?.steps[0]?.instruction ||
          liveWf2?.steps.map((s) => s.label).join(" → ") ||
          wf.name;
        const proposal = maybeProposeSpawn({
          status,
          novelty,
          threshold: spawnThreshold,
          openSourceIds,
          sourceWorkflowId: wf.id,
          sourceWorkflowName: wf.name,
          sourceRunId: runId,
          taskExcerpt,
        });
        if (proposal) {
          st.addProposal(proposal);
          toast("Evolution proposal added to the inbox", {
            icon: "🧬",
            description: `${wf.name} keeps producing similar output (novelty ${Math.round(novelty)}%) — a variation was suggested`,
          });
        }
      } catch {
        /* spawn proposals are best-effort — never affect run finalization */
      }
    }
    patchRun({
      status,
      finishedAt: Date.now(),
      ...(novelty !== undefined ? { novelty } : {}),
      ...(errorInfo ? { error: errorInfo } : status === "done" ? { error: undefined } : {}),
    });
    if (source === "scheduled") {
      // r29 scheduled-run autonomy (Temporal/Circuit-Breaker doctrine):
      // failures feed a consecutive-fail streak — 1-2 re-arm SOONER than the
      // full interval (10m/30m quick retries); 3 trips the breaker and
      // auto-pauses the schedule so a broken pipeline stops burning slots.
      // Success resets the streak. A half-open probe = the user re-enabling.
      const live = useWorkflowsStore.getState().workflows.find((w) => w.id === wf.id);
      const sched = live?.schedule;
      if (sched && (status === "done" || status === "error")) {
        if (status === "done" && sched.failStreak) {
          useWorkflowsStore.getState().update(wf.id, { schedule: { ...sched, failStreak: 0 } });
        } else if (status === "error" && sched.enabled) {
          const streak = (sched.failStreak ?? 0) + 1;
          if (streak >= 3) {
            useWorkflowsStore.getState().update(wf.id, { schedule: { ...sched, failStreak: streak, enabled: false } });
            toast.warning("Schedule auto-paused after 3 consecutive failures", {
              icon: "🛑",
              description: `${wf.name} — the pipeline keeps failing at "${errorInfo?.stepLabel ?? "a step"}". Fix it, then re-enable the schedule.`,
            });
          } else {
            const retryIn = Math.min(Math.max(60_000, sched.intervalMs), streak === 1 ? 10 * 60_000 : 30 * 60_000);
            useWorkflowsStore.getState().update(wf.id, { schedule: { ...sched, failStreak: streak, nextRunAt: Date.now() + retryIn } });
          }
        }
      }
      if (status === "done") toast.success("Scheduled run finished", { icon: "⏰", description: `${wf.name} · ${steps.length} steps` });
      else if (status === "error") {
        const sched2 = useWorkflowsStore.getState().workflows.find((w) => w.id === wf.id)?.schedule;
        const retryNote = sched2?.enabled && sched2.failStreak && sched2.failStreak < 3
          ? ` — auto-retry ${sched2.failStreak === 1 ? "in ~10m" : "in ~30m"}`
          : "";
        toast.error("Scheduled run failed", { icon: "⏰", description: errorInfo ? `${errorInfo.stepLabel} · ${ERROR_KIND_META[errorInfo.kind].label.toLowerCase()}${retryNote} — open the run to recover` : wf.name });
      }
    } else {
      if (status === "done") toast.success(toastMsg);
      else if (status === "error" && errorInfo) {
        // Non-silent failure: tell the user WHERE to recover, not just that it broke.
        toast.error(`Run failed at "${errorInfo.stepLabel}"`, {
          icon: "🛟",
          description: `${ERROR_KIND_META[errorInfo.kind].label} issue · ${errorInfo.stepsDone}/${steps.length} steps done — recovery options are in the run panel.`,
        });
      }
    }
    onSettled?.(runId, status);
  };

  /** Build the full RunErrorInfo for a failed step and finish the run. */
  const failRun = (fallbackIndex: number, err: Error) => {
    // v23: a rejection reason that is not an Error (undefined, a string) used
    // to leak a literal `undefined` into the error row and the dev overlay.
    const safeMessage = err instanceof Error ? err.message : String(err ?? "unknown error");
    const meta = err as Error & { stepId?: string; toolCallsOk?: number; autoRetried?: boolean };
    const found = steps.findIndex((s) => s.stepId === meta.stepId);
    const failedIndex = found === -1 ? fallbackIndex : found;
    const step = steps[failedIndex] ?? steps[fallbackIndex];
    const { kind, hint } = classifyRunError(safeMessage);
    const llm = resolveLlm(settings.settings);
    const info: RunErrorInfo = {
      stepIndex: failedIndex,
      stepId: step.stepId,
      stepLabel: step.label,
      agentName: step.agentName,
      message: safeMessage,
      kind,
      hint,
      toolCallsOk: meta.toolCallsOk ?? 0,
      stepsDone: steps.slice(0, failedIndex).filter((s) => s.status === "done").length,
      llmLabel: llm.label,
      attempts: attempts + 1,
      autoRetried: meta.autoRetried === true || undefined,
    };
    stopRemaining(failedIndex);
    finish("error", `Step "${step.label}" failed`, info);
  };

  /**
   * Stream one agent call for a run step; returns the final content + duration.
   * Self-healing (r19): a transient engine failure (network drop / timeout —
   * e.g. a gateway 502 after several tool calls) is retried ONCE automatically
   * with a clean slate so scheduled runs survive upstream hiccups instead of
   * dying at 7am. Every attempt is recorded in the run's call log.
   */
  const streamStep = async (
    runStep: WorkflowRunStep,
    agentId: string,
    system: string,
    context: string
  ): Promise<{ content: string; ms: number }> => {
    const agent = useAgentsStore.getState().agents.find((a) => a.id === agentId);
    if (!agent) throw new Error(`Agent for step "${runStep.label}" not found`);
    const stepStart = Date.now();
    let draft = "";
    let localToolCalls: ToolCallInfo[] = [];
    const llm = resolveLlm(settings.settings, agent.model);
    // Synthetic deep-research passes carry a merged tool set (base tools +
    // web_search + arxiv_search) materialized on the run step itself.
    const effectiveTools: ToolId[] = runStep.tools ?? agent.tools ?? [];
    // Task fit (Genius-rotator doctrine): research steps with search tools
    // prefer fast models first (many quick tool rounds); review/writing steps
    // prefer flagships first (one excellent pass matters most).
    const taskFit: RelayTaskFit =
      runStep.kind === "review"
        ? "quality"
        : effectiveTools.some((t) => t === "web_search" || t === "read_url" || t === "arxiv_search")
          ? "research"
          : "any";
    // Model Relay (Genius-rotator doctrine): when this step's brain fails
    // before streaming anything, the server rotates down the vault's fallback
    // chain instead of dying — the exact 7am-scheduled-run failure mode.
    let relayNotes: string[] = [];
    const MAX_STEP_ATTEMPTS = 3; // 1 real attempt + 2 automatic self-heal retries (r83: 2→3 — forensics from two independent failed deep runs (user's Continuous Research 08:xx, QA-profile dossier 07:xx) showed attempt-2-on-a-fresh-lane ALSO dying during the same provider outage window; a third lane dial is the difference between a saved 457s research pass and a terminal error. Each attempt is bounded by the engine's upstream deadlines, so a dead lane costs minutes, not the run.)

    // v22 (mid-stream primary demotion): a provider that dies MID-STREAM —
    // tool rounds streamed, then the socket dropped — is provably sick, but
    // the old ladder re-dialed it FIRST on every attempt (the user's
    // Continuous Research run burned ~26 minutes on one dead Vyce endpoint:
    // 4/5 dials died at 104–731s each). Attempts 2/3 now demote the primary:
    // lead with the built-in engine and park the sick primary at the BACK of
    // the hop chain (its own key rides along, so it stays reachable). BYOK
    // intact — the auto lane needs no key and touches none of the vault.
    let demotePrimary = false;

    for (let attempt = 1; attempt <= MAX_STEP_ATTEMPTS; attempt++) {
      // Rebuild the relay wire PER ATTEMPT (r25): attempt 1's failures were
      // recorded into the rotator's health memory as they happened, so the
      // self-heal retry now starts on a DIFFERENT lane instead of re-dialing
      // the same dead primary — the actual "auto-retry hits the same dead
      // hop" fix.
      // v22: when the PREVIOUS attempt died mid-stream on the primary, stop
      // leading with it — dial the built-in engine instead.
      let dialLlm = llm;
      if (attempt > 1 && demotePrimary && !forceServer) {
        const auto = resolveLlm(settings.settings, "auto");
        dialLlm = {
          ...llm,
          provider: auto.provider,
          apiKey: undefined,
          baseUrl: undefined,
          model: undefined,
          providerId: "auto",
          label: `${llm.label} → auto (primary demoted)`,
        };
      }
      const relayHops: RelayWireHop[] = [
        ...buildRelayWire(
          settings.settings,
          { providerId: dialLlm.providerId, model: dialLlm.model },
          { taskFit }
        ),
        ...(dialLlm !== llm && llm.providerId !== "auto"
          ? [
              {
                key: `${llm.providerId}::${llm.model ?? ""}`,
                ...(llm.baseUrl ? { baseUrl: llm.baseUrl } : {}),
                ...(llm.apiKey ? { apiKey: llm.apiKey } : {}),
                model: llm.model ?? "",
                label: llm.label,
              },
            ]
          : []),
      ];
      try {
        draft = "";
        localToolCalls = [];
        relayNotes = [];
        if (dialLlm !== llm) {
          relayNotes.push(
            `primary demoted after a mid-stream drop — built-in engine dialed first, ${llm.label} parked as last hop`
          );
        }
        const res = await runAgentChat(
          {
            provider: dialLlm.provider,
            apiKey: dialLlm.apiKey,
            baseUrl: dialLlm.baseUrl,
            model: dialLlm.model,
            providerId: dialLlm.providerId,
            temperature: agent.temperature,
            maxIterations: agent.maxIterations,
            tools: effectiveTools,
            system,
            messages: [{ role: "user", content: context }],
            ...(relayHops.length > 0 ? { relay: relayHops } : {}),
            ...(forceServer ? { forceServer: true } : {}),
            signal,
          },
          {
            onStatus: (m) => {
              if (/Model relay:/i.test(m)) {
                relayNotes.push(m);
                // Feed the rotator's health memory: [hop:x] = x failed,
                // [hopok:x] = x answered after a rotation.
                const failHop = /\[hop:([^\]]+)\]/.exec(m);
                if (failHop) recordRelayHopResult(failHop[1], false, m.replace(/\s*\[hop:[^\]]+\]\s*$/, ""));
                const okHop = /\[hopok:([^\]]+)\]/.exec(m);
                if (okHop) recordRelayHopResult(okHop[1], true);
              }
            },
            onToken: (t) => {
              draft += t;
              patchRunStep(runStep.stepId, { output: draft });
            },
            onToolCall: (c) => {
              localToolCalls.push({ id: c.id, name: c.name, args: c.args });
              patchRunStep(runStep.stepId, { toolCalls: [...localToolCalls] });
            },
            onToolResult: (r) => {
              const idx = localToolCalls.findIndex((tc) => tc.id === r.id);
              if (idx !== -1) {
                localToolCalls[idx] = {
                  ...localToolCalls[idx],
                  result: r.content,
                  ok: r.ok,
                  ms: r.ms,
                };
              }
              patchRunStep(runStep.stepId, { toolCalls: [...localToolCalls] });
            },
          }
        );
        pushCall({
          stepId: runStep.stepId,
          stepLabel: runStep.label,
          agentName: agent.name,
          engine: dialLlm.label,
          model: dialLlm.model,
          ms: Date.now() - stepStart,
          ok: true,
          attempt,
          ...(res.transport === "browser-direct"
            ? { note: ["browser-direct — key stayed in your browser", ...relayNotes].join(" → ") }
            : res.transport === "server"
              ? // v11b: lane attribution for EVERY relay-served call (incl. the
                // v10 auto-fallback and v11 forced retries) — previously only
                // browser-direct and hop-note runs were labelled, so a quiet
                // relay win was indistinguishable from a direct win.
                { note: [forceServer ? "server relay (forced retry — direct lane skipped)" : "server relay — routed through the app's vault chain", ...relayNotes].join(" → ") }
              : relayNotes.length > 0
                ? { note: relayNotes.join(" → ") }
                : {}),
        });
        patchRunStep(runStep.stepId, {
          output: res.content,
          toolCalls: res.toolCalls.length > 0 ? res.toolCalls : localToolCalls,
          status: "done",
          ms: Date.now() - stepStart,
          // r29: budget-sentinel answers are marked degraded — the UI shows an
          // "auto-digest" chip and downstream steps can tell material is thin.
          degraded: /^_The model ended/.test(res.content) || undefined,
        });
        return { content: res.content, ms: Date.now() - stepStart };
      } catch (err) {
        if (isAbortError(err)) {
          pushCall({
            stepId: runStep.stepId,
            stepLabel: runStep.label,
            agentName: agent.name,
            engine: dialLlm.label,
            model: dialLlm.model,
            ms: Date.now() - stepStart,
            ok: false,
            error: "aborted by user",
            attempt,
          });
          patchRunStep(runStep.stepId, {
            status: "stopped",
            output: draft || "(stopped)",
          });
          throw err;
        }
        const message = (err as Error).message ?? "unknown error";
        pushCall({
          stepId: runStep.stepId,
          stepLabel: runStep.label,
          agentName: agent.name,
          engine: dialLlm.label,
          model: dialLlm.model,
          ms: Date.now() - stepStart,
          ok: false,
          error: message,
          attempt,
          ...(relayNotes.length > 0 ? { note: relayNotes.join(" → ") } : {}),
        });
        // ─── Self-heal: up to two clean retries for transient engine failures ──────
        // r25: the engine now ships a structured `kind` on server errors —
        // use it when present; the message-regex stays as the fallback for
        // browser-direct errors.
        const kind =
          ((err as { kind?: RunErrorKind }).kind ?? classifyRunError(message).kind);
        // v22: tool rounds streamed this attempt → the drop was MID-STREAM.
        // Demote the primary so the next attempt leads with the built-in
        // engine instead of re-dialing the provably sick endpoint first.
        if (localToolCalls.length > 0 && SELF_HEAL_KINDS.includes(kind)) {
          demotePrimary = true;
        }
        if (attempt < MAX_STEP_ATTEMPTS && SELF_HEAL_KINDS.includes(kind) && !signal.aborted) {
          // v23: a 429 is congestion, not flakiness — re-dialing within seconds
          // burns the whole ladder inside the same quota window (the user's
          // Continuous Research run recorded 3 failed 429 dials back-to-back;
          // v21b's server-side lesson now mirrored client-side).
          if (kind === "rate-limit") {
            const cooldown = attempt === 1 ? 20_000 : 45_000;
            toast.info(`"${runStep.label}" is rate-limited — cooling down ${Math.round(cooldown / 1000)}s before retry ${attempt + 1}/${MAX_STEP_ATTEMPTS}…`, {
              icon: "⏳",
              description: "Free-tier quota windows refill — hammering them just burns attempts.",
            });
            await new Promise((r) => setTimeout(r, cooldown));
            if (signal.aborted) {
              throw new DOMException("Aborted during rate-limit cool-down", "AbortError");
            }
          }
          toast.info(`"${runStep.label}" hit a ${kind} hiccup — auto-retry ${attempt + 1}/${MAX_STEP_ATTEMPTS} on a fresh lane…`, {
            icon: "🛟",
            description: demotePrimary
              ? "Primary demoted after its mid-stream drop — this retry dials the built-in engine first. Tool results already gathered are re-run safely."
              : "The engine dropped the call mid-step. Tool results already gathered are re-run safely.",
          });
          patchRunStep(runStep.stepId, { status: "running", output: "", toolCalls: [] });
          continue;
        }
        // Attach recovery metadata so failRun can attribute the failure precisely.
        const meta = err as Error & { stepId?: string; toolCallsOk?: number; autoRetried?: boolean };
        meta.stepId = runStep.stepId;
        meta.toolCallsOk = localToolCalls.filter((tc) => tc.ok === true).length;
        meta.autoRetried = attempt > 1;
        patchRunStep(runStep.stepId, {
          status: "error",
          output: `${draft ? `${draft}\n\n` : ""}**Error:** ${message}`,
        });
        throw err;
      }
    }
    // Unreachable (loop either returns or throws) — kept for the type checker.
    throw new Error(`Step "${runStep.label}" exhausted its attempts.`);
  };

  try {
    // Resume: rebuild the conversation context from every completed step
    // before the resume point — nothing the user already paid for is lost.
    const prev: PrevStepOutput[] =
      startIndex > 0
        ? steps
            .slice(0, startIndex)
            .filter((s) => s.status === "done" && s.output.trim() !== "")
            .map((s) => ({ label: s.label, agentName: s.agentName, output: s.output, degraded: s.degraded }))
        : [];
    const framework = settings.settings.framework;

    for (let i = startIndex; i < steps.length; i++) {
      const step = steps[i];
      const def = wf.steps.find((s) => s.id === step.stepId);
      const kind = def?.kind ?? "generate";
      // Authored steps take their instruction from the definition; synthetic
      // depth passes (no def) carry their appended focus on the run row itself.
      const instruction = def ? def.instruction : step.instruction;
      const baseSystem = instruction
        ? `${useAgentsStore.getState().agents.find((a) => a.id === step.agentId)?.instructions ?? ""}\n\nFOCUS FOR THIS STEP: ${instruction}`
        : useAgentsStore.getState().agents.find((a) => a.id === step.agentId)?.instructions ?? "";

      const agentRow = useAgentsStore
        .getState()
        .agents.find((a) => a.id === step.agentId);
      if (!agentRow) {
        patchRunStep(step.stepId, { status: "error", output: "Agent not found" });
        failRun(i, new Error(`Agent "${step.agentName}" was deleted — re-add it to this workflow, then resume.`));
        return runId;
      }

      // ─── Review gate: audit the previous step, may force one rework pass ───
      if (kind === "review" && i > 0) {
        const reviewed = steps[i - 1];
        const context = buildReviewContext(
          task,
          prev[prev.length - 1] ?? {
            label: reviewed.label,
            agentName: reviewed.agentName,
            output: reviewed.output,
          }
        );

        let reworks = 0;
        // Bounded loop: review → (rework previous → review again) → continue
        for (;;) {
          try {
            const { content, ms } = await streamStep(step, step.agentId, baseSystem, context);
            const verdict = parseReviewVerdict(content);

            if (verdict === "pass" || reworks >= REWORK_LIMIT) {
              patchRunStep(step.stepId, {
                status: "done",
                output: content,
                verdict: verdict === "pass" ? "pass" : "rework",
                kind: "review",
                ms,
              });
              prev.push({
                label: step.label,
                agentName: agentRow.name,
                degraded: /^_The model ended/.test(content) || undefined,
                output:
                  verdict === "pass"
                    ? content
                    : `${content}\n\n(Note: the reviewer still wanted changes after ${REWORK_LIMIT} rework pass${REWORK_LIMIT === 1 ? "" : "es"} — pipeline continued.)`,
              });
              break;
            }

            // ─── Rework: re-run the previous generate step with feedback ───
            reworks++;
            const feedback = content;
            patchRunStep(step.stepId, {
              status: "done",
              output: feedback,
              verdict: "rework",
              kind: "review",
              ms,
            });
            toast.warning("Review gate sent the step back for rework", {
              icon: "↻",
              description: `${step.label} → ${reviewed.label} (pass ${reworks}/${REWORK_LIMIT + 1})`,
            });

            const genAgent = useAgentsStore
              .getState()
              .agents.find((a) => a.id === reviewed.agentId);
            if (!genAgent) {
              patchRunStep(reviewed.stepId, { status: "error", output: "Agent not found" });
              failRun(i, new Error(`Agent "${reviewed.agentName}" was deleted — re-add it to this workflow, then resume.`));
              return runId;
            }
            const reviewedDef = wf.steps.find((s) => s.id === reviewed.stepId);
            const genBase = reviewedDef?.instruction
              ? `${genAgent.instructions}\n\nFOCUS FOR THIS STEP: ${reviewedDef.instruction}`
              : genAgent.instructions;
            const reworkSystem = `${genBase}\n\nREWORK REQUIRED — your previous attempt was rejected by the review gate. Reviewer feedback: ${feedback}\nAddress every point and deliver an improved result.`;

            // Rebuild the context WITHOUT the reviewed step's stale output
            prev.pop();
            const genContext =
              framework === "sequential"
                ? buildSequentialContext(task, prev)
                : buildConversationalContext(task, prev);

            patchRunStep(reviewed.stepId, { status: "running", reworked: true });
            const gen = await streamStep(
              reviewed,
              reviewed.agentId,
              reworkSystem,
              genContext
            );
            prev.push({
              label: reviewed.label,
              agentName: genAgent.name,
              degraded: /^_The model ended/.test(gen.content) || undefined,
              output: gen.content,
            });
            // Loop → the review gate runs again on the improved output
          } catch (err) {
            if (isAbortError(err)) {
              if (stalledRuns.has(wf.id)) {
                // Watchdog abort: bounded auto-resume, else manual-resume card.
                stalledRuns.delete(wf.id);
                const stalledRun = useWorkflowsStore
                  .getState()
                  .workflows.find((w) => w.id === wf.id)
                  ?.runs.find((r) => r.id === runId);
                if ((stalledRun?.resumeCount ?? 0) < MAX_AUTO_RESUMES) {
                  failRun(
                    i,
                    new Error(
                      `Step timed out — no model output for over ${stallTimeoutLabel()}. Auto-resuming (attempt ${(stalledRun?.resumeCount ?? 0) + 1}/${MAX_AUTO_RESUMES})…`
                    )
                  );
                  scheduleAutoResume(wf.id, runId, i, stalledRun?.resumeCount ?? 0);
                  return runId;
                }
                failRun(
                  i,
                  new Error(
                    `Step timed out — no model output for over ${stallTimeoutLabel()}. The stream stalled (background tab throttling or a dropped connection). Every completed step is preserved — resume from here.`
                  )
                );
                return runId;
              }
              stopRemaining(i);
              finish("stopped", "Pipeline stopped");
              return runId;
            }
            failRun(i, err as Error);
            return runId;
          }
        }
        continue;
      }

      // ─── Regular generate step ────────────────────────────────────────────
      const context =
        framework === "sequential"
          ? buildSequentialContext(task, prev)
          : buildConversationalContext(task, prev);

      try {
        // ─── r27 SYSTEM-ONE GATE (Jev doctrine: not everything requires a
        // frontier model): a cheap calibrated judge decides whether the
        // flagship verification pass is even needed. A confident PASS skips
        // the extra frontier call entirely; FAIL, low confidence or "no
        // judge available" keeps the full pass — worst case = status quo.
        if (step.instruction === VERIFICATION_INSTRUCTION) {
          const draft = prev[prev.length - 1]?.output ?? "";
          const gate = await decide({
            settings: settings.settings,
            signal,
            state: `TASK:\n${task}\n\nDRAFT OUTPUT (the previous step's deliverable):\n${draft.slice(0, 6000)}`,
            question: {
              id: "verify-gate",
              type: "noul",
              prompt:
                "Is this draft a COMPLETE final deliverable for the task — on-topic, no placeholder text, no unanswered sub-questions, and no obviously unsupported load-bearing claims? Minor polish issues do not count against it.",
            },
          });
          if (gate && gate.answer === "yes" && gate.confidence >= SYSTEMONE_GATE_CONFIDENCE) {
            patchRunStep(step.stepId, {
              output: draft,
              toolCalls: [],
              status: "done",
              ms: gate.ms,
            });
            pushCall({
              stepId: step.stepId,
              stepLabel: step.label,
              agentName: agentRow.name,
              engine: gate.judge,
              model: gate.via,
              ms: gate.ms,
              ok: true,
              attempt: 1,
              note: `System-One gate PASS ${(gate.confidence * 100).toFixed(0)}% (${gate.via}) — flagship verification pass skipped`,
            });
            toast("System-One gate passed", {
              icon: "✓",
              description: `${(gate.confidence * 100).toFixed(0)}% confident via ${gate.via === "jev" ? "Jev" : "fast judge"} — verification pass skipped`,
            });
            prev.push({ label: step.label, agentName: agentRow.name, degraded: /^_The model ended/.test(draft) || undefined, output: draft });
            continue;
          }
          // FAIL / uncertain / no judge available → run the full verification pass.
        }
        const { content } = await streamStep(step, step.agentId, baseSystem, context);
        prev.push({ label: step.label, agentName: agentRow.name, degraded: /^_The model ended/.test(content) || undefined, output: content });
      } catch (err) {
        if (isAbortError(err)) {
          if (stalledRuns.has(wf.id)) {
            // Watchdog abort: bounded auto-resume, else manual-resume card.
            stalledRuns.delete(wf.id);
            const stalledRun = useWorkflowsStore
              .getState()
              .workflows.find((w) => w.id === wf.id)
              ?.runs.find((r) => r.id === runId);
            if ((stalledRun?.resumeCount ?? 0) < MAX_AUTO_RESUMES) {
              failRun(
                i,
                new Error(
                  `Step timed out — no model output for over ${stallTimeoutLabel()}. Auto-resuming (attempt ${(stalledRun?.resumeCount ?? 0) + 1}/${MAX_AUTO_RESUMES})…`
                )
              );
              scheduleAutoResume(wf.id, runId, i, stalledRun?.resumeCount ?? 0);
              return runId;
            }
            failRun(
              i,
              new Error(
                `Step timed out — no model output for over ${stallTimeoutLabel()}. The stream stalled (background tab throttling or a dropped connection). Every completed step is preserved — resume from here.`
              )
            );
            return runId;
          }
          stopRemaining(i);
          finish("stopped", "Pipeline stopped");
          return runId;
        }
        failRun(i, err as Error);
        return runId;
      }
    }

    finish("done", startIndex > 0 ? "Pipeline resumed & finished" : "Pipeline finished");
    return runId;
  } catch (err) {
    // v23: the loop's inner catches own step errors; anything landing here
    // escaped through a gap (context builders, finalizer internals, callbacks)
    // and used to reject the run promise — the user-visible result was the
    // Next.js overlay's "Runtime Error: undefined". Finalize honestly instead:
    // mark the run error, keep partial output, log the escaped cause.
    console.error("[workflow-runner] escaped run error", err);
    try {
      failRun(startIndex, err instanceof Error ? err : new Error(String(err ?? "unknown run error")));
    } catch (finalizerErr) {
      console.error("[workflow-runner] finalizer itself failed", finalizerErr);
    }
    return runId;
  } finally {
    activeRuns.delete(wf.id);
    activeControllers.delete(wf.id);
    lastRunActivity.delete(wf.id);
    stalledRuns.delete(wf.id);
    useUiStore.getState().setBusy(false);
  }
}
