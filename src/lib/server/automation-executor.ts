// ─── r204: the missing server executor (Local Automation Vault epic) ─────────
// The v20 layer (registry routes, ServerAutopilot panel, automation-bridge
// push) has existed for months, but NOTHING claimed due AutomationWorkflow
// rows — closed-tab schedules were dead and run-now just moved nextRunAt for
// a scheduler that never existed. This module is that scheduler.
//
// Contract (BYOK-preserving, per the epic doctrine):
//   • The claim loop STANDS DOWN while the open tab's heartbeat is fresh —
//     the client lane drives with keys that never leave the browser.
//   • Only when the heartbeat is STALE (>120s = tab closed) does the server
//     claim due rows, and it dials exclusively with an OPT-IN key from the
//     local AutomationVault table (local SQLite, never leaves this machine).
//     No vault key = honest no-op, never a shared/implicit credential.
//   • The "builtin" vault slot has no server-side endpoint pairing (the
//     built-in SDK's gateway is client-side knowledge), so the executor v1
//     dials only through a REAL registry provider (providerById) — the
//     builtin slot is skipped with an explicit reason, not guessed.
//
// Everything here is exported so scripts/qa-automation-executor.ts can drive
// tickOnce() directly against the real database — the loop is just wiring.

import { db } from "@/lib/db";
import { providerById, providerBaseUrl } from "@/lib/providers";

export const CLAIM_INTERVAL_MS = 15_000;
export const HEARTBEAT_STALE_MS = 120_000;
/** r171 parity: 3 consecutive failures park the schedule (client breaker). */
export const BREAKER_LIMIT = 3;
const DIAL_TIMEOUT_MS = 90_000;

interface VaultStep {
  label: string;
  agentName?: string;
  prompt: string;
}

export interface TickResult {
  claimed: number;
  /** Why nothing was claimed (only when claimed === 0). */
  reason?: "client-alive" | "no-vault-key" | "no-resolvable-provider" | "idle";
  workflowIds: string[];
  /** Present when claimed === 1 — the run outcome for QA/panel reads. */
  outcome?: { runId: string; status: "done" | "error" };
}

interface ResolvedDial {
  url: string;
  key: string;
  model: string;
  providerLabel: string;
}

/**
 * Resolve the dial endpoint for the server lane from the vault.
 * Returns null (with a machine-readable reason in `why`) when no opt-in key
 * can be paired with a real registry endpoint — the executor never invents
 * endpoints or falls back to implicit credentials.
 */
export function resolveServerDial(
  vaultEntry: { provider: string; key: string } | null,
): { dial: ResolvedDial } | { dial: null; why: "no-vault-key" | "no-resolvable-provider" } {
  if (!vaultEntry || !vaultEntry.key.trim()) return { dial: null, why: "no-vault-key" };
  const reg = providerById(vaultEntry.provider);
  if (!reg) return { dial: null, why: "no-resolvable-provider" }; // "builtin" or unknown id
  // registry models are ProviderModel objects — the dial needs the raw id
  const firstModel = Array.isArray(reg.models) ? reg.models[0] : undefined;
  const model =
    typeof firstModel === "string"
      ? firstModel
      : ((firstModel as { id?: string } | undefined)?.id ?? "");
  if (!reg.baseUrl && !providerBaseUrl(reg)) return { dial: null, why: "no-resolvable-provider" };
  return {
    dial: {
      url: `${providerBaseUrl(reg).replace(/\/$/, "")}/chat/completions`,
      key: vaultEntry.key.trim(),
      model,
      providerLabel: reg.name,
    },
  };
}

/** One non-streaming OpenAI-compatible chat completion for a single step. */
export async function dialStep(dial: ResolvedDial, prompt: string): Promise<string> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), DIAL_TIMEOUT_MS);
  try {
    const res = await fetch(dial.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${dial.key}`,
      },
      body: JSON.stringify({
        model: dial.model,
        messages: [
          {
            role: "system",
            content:
              "You are executing one step of a scheduled automation pipeline. Answer the step prompt directly and concisely.",
          },
          { role: "user", content: prompt },
        ],
        max_tokens: 2000,
        temperature: 0.7,
      }),
      signal: ac.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`dial ${res.status}: ${body.slice(0, 200)}`);
    }
    const j = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const text = j.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error("dial returned empty completion");
    return text;
  } finally {
    clearTimeout(timer);
  }
}

/** Execute one claimed workflow end-to-end with honest run bookkeeping. */
export async function executeWorkflow(
  wf: { id: string; name: string; task: string; stepsJson: string; intervalMs: number },
  dial: ResolvedDial,
): Promise<{ runId: string; status: "done" | "error" }> {
  let steps: VaultStep[] = [];
  try {
    const parsed = JSON.parse(wf.stepsJson) as VaultStep[];
    if (Array.isArray(parsed)) steps = parsed;
  } catch {
    /* corrupt stepsJson → runs as one prompt below */
  }
  if (steps.length === 0 && wf.task.trim()) {
    steps = [{ label: "Run task", prompt: wf.task }];
  }

  const run = await db.automationRun.create({
    data: {
      workflowId: wf.id,
      workflowName: wf.name,
      trigger: "schedule",
      status: "running",
      stepsTotal: steps.length,
      stepsJson: "[]",
    },
  });

  const outputs: { label: string; output: string; ms: number; ok: boolean }[] = [];
  try {
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const t0 = Date.now();
      try {
        const output = await dialStep(dial, step.prompt || step.label);
        outputs.push({ label: step.label, output, ms: Date.now() - t0, ok: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        outputs.push({
          label: step.label,
          output: `step failed: ${message}`,
          ms: Date.now() - t0,
          ok: false,
        });
        throw Object.assign(new Error(`step ${i + 1}/${steps.length} "${step.label}" failed: ${message}`), {
          stepIndex: i,
        });
      } finally {
        // Progress writes land even on the failing step — the panel shows
        // exactly where a dead run stopped (r80 honesty, server lane).
        await db.automationRun.update({
          where: { id: run.id },
          data: { currentStep: i + 1, stepsJson: JSON.stringify(outputs) },
        });
      }
    }
    const report = outputs.map((o) => `## ${o.label}\n${o.output}`).join("\n\n");
    await db.automationRun.update({
      where: { id: run.id },
      data: { status: "done", finalReport: report, finishedAt: new Date() },
    });
    await db.automationWorkflow.update({
      where: { id: wf.id },
      data: {
        lastRunAt: new Date(),
        nextRunAt: new Date(Date.now() + wf.intervalMs),
        failStreak: 0,
      },
    });
    return { runId: run.id, status: "done" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.automationRun.update({
      where: { id: run.id },
      data: { status: "error", error: message, finishedAt: new Date() },
    });
    // Breaker parity with the client lane (r171): at BREAKER_LIMIT the
    // schedule parks itself instead of burning the vault key on a dead lane.
    const streak = (await db.automationWorkflow.findUnique({ where: { id: wf.id } }))?.failStreak ?? 0;
    const nextStreak = streak + 1;
    await db.automationWorkflow.update({
      where: { id: wf.id },
      data: {
        lastRunAt: new Date(),
        nextRunAt: new Date(Date.now() + wf.intervalMs),
        failStreak: nextStreak,
        ...(nextStreak >= BREAKER_LIMIT ? { enabled: false } : {}),
      },
    });
    return { runId: run.id, status: "error" };
  }
}

/**
 * One claim tick: stand down on a fresh heartbeat, else claim and execute
 * at most ONE due workflow per tick (bounded latency, no thundering herd).
 */
export async function tickOnce(now = new Date()): Promise<TickResult> {
  const state = await db.automationState.findUnique({ where: { id: "singleton" } });
  if (state && now.getTime() - state.lastSeenAt.getTime() < HEARTBEAT_STALE_MS) {
    return { claimed: 0, reason: "client-alive", workflowIds: [] };
  }

  const due = await db.automationWorkflow.findMany({
    where: { enabled: true, nextRunAt: { lte: now } },
    orderBy: { nextRunAt: "asc" },
    take: 1,
  });
  if (due.length === 0) return { claimed: 0, reason: "idle", workflowIds: [] };

  const vaultEntry = await db.automationVault.findFirst({ orderBy: { createdAt: "asc" } });
  const resolved = resolveServerDial(
    vaultEntry ? { provider: vaultEntry.provider, key: vaultEntry.key } : null,
  );
  if (!resolved.dial) return { claimed: 0, reason: resolved.why, workflowIds: [] };

  const wf = due[0];
  const outcome = await executeWorkflow(
    {
      id: wf.id,
      name: wf.name,
      task: wf.task,
      stepsJson: wf.stepsJson,
      intervalMs: wf.intervalMs,
    },
    resolved.dial,
  );
  return { claimed: 1, workflowIds: [wf.id], outcome };
}

/** Boot the interval loop exactly once per server process (HMR-safe). */
export function startAutomationExecutor(): void {
  const g = globalThis as unknown as { __automationExecutor?: NodeJS.Timeout };
  if (g.__automationExecutor) return;
  g.__automationExecutor = setInterval(() => {
    void tickOnce().catch((err) => {
      console.error("[automation-executor] tick failed:", err instanceof Error ? err.message : err);
    });
  }, CLAIM_INTERVAL_MS);
  console.info("[automation-executor] claim loop started (15s tick, stands down while the tab heartbeat is fresh)");
}
