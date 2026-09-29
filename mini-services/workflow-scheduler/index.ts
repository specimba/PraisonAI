// ─── v20: Headless workflow autopilot (mini-service) ────────────────────────
// Fires scheduled workflow runs server-side while the app tab is CLOSED.
// Doctrine:
//   - Local-first: everything runs on this machine, results land in the local
//     SQLite DB. BYOK keys are NOT needed here and never leave the browser —
//     headless steps dial the platform's built-in engine.
//   - Stand-down: while the client heartbeat is fresh (<2min), the server does
//     nothing — the in-app scheduler drives with the user's own keys.
//   - Claim-then-run: nextRunAt is advanced BEFORE execution so a slow run can
//     never double-fire on the next tick.
//   - Circuit breaker: 3 consecutive failures pause the schedule (mirrors the
//     client-side breaker doctrine).

import { PrismaClient } from "@prisma/client";
import ZAI from "z-ai-web-dev-sdk";

const prisma = new PrismaClient();
const TICK_MS = 30_000;
const TICK_JITTER = 0.2; // v21: ±20% jitter — ticks never align with other 30s cadence loops
const HEARTBEAT_STALE_MS = 120_000;
const inFlight = new Set<string>();
// v21: the built-in engine dials a shared gateway — 429 congestion is
// environmental (proven live in r109's E2E), not a workflow defect.
// Rate-limit hits get longer per-attempt waits, and the next RUN is pushed
// out failStreak-scaled (capped 10min) instead of re-burning attempts.
const RATE_LIMIT_RE = /\b(429|too many requests|rate.?limit)\b/i;
// r116: transient = environmental noise (gateway congestion, the app restarting
// mid-dial — proven live 11:25Z when three schedules fired into the restart
// window and all errored). Same backoff family as 429, but NEVER trips the
// circuit breaker — a schedule must survive infra blips, only genuine
// workflow defects (empty output, bad steps) earn a pause.
const TRANSIENT_RE = /\b(socket connection|econnreset|econnrefused|fetch failed|network|premature close|terminated|etimeout|timeout)\b/i;
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const isTransient = (e: unknown) => TRANSIENT_RE.test(errMsg(e));
const isRateLimit = (e: unknown) => RATE_LIMIT_RE.test(errMsg(e));
const rateLimitBackoffMs = (streak: number) => Math.min(streak, 10) * 60_000;

type StepDef = { label: string; agentName?: string; prompt: string };

async function clientAlive(): Promise<boolean> {
  const st = await prisma.automationState.findUnique({ where: { id: "singleton" } });
  return !!st && Date.now() - st.lastSeenAt.getTime() < HEARTBEAT_STALE_MS;
}

async function executeRun(
  wf: { id: string; name: string; task: string; stepsJson: string; failStreak: number; intervalMs: number },
  trigger: "schedule" | "manual"
): Promise<void> {
  let steps: StepDef[] = [];
  try {
    steps = JSON.parse(wf.stepsJson) as StepDef[];
  } catch {
    steps = [];
  }
  if (!steps.length) steps = [{ label: "Execute pipeline", prompt: wf.task }];

  const run = await prisma.automationRun.create({
    data: {
      workflowId: wf.id,
      workflowName: wf.name,
      trigger,
      stepsTotal: steps.length,
      status: "running",
    },
  });
  console.log(`[autopilot] run ${run.id} started — "${wf.name}" (${steps.length} steps, ${trigger})`);

  const outputs: { label: string; output: string; ms: number; ok: boolean }[] = [];
  try {
    const zai = await ZAI.create();
    // v25: Local Automation Vault — an opt-in key stored in the local DB
    // (provider "builtin") overrides the shared gateway key for THIS headless
    // dial, so closed-tab runs use the user's own quota instead of hammering
    // the built-in lane (the source of the r109-era 429 storms). The browser
    // BYOK lane is untouched — keys there never leave the tab. The SDK's
    // constructor is typed private, so the override goes through a narrow
    // instance cast; a failed lookup falls back to the stock key silently.
    try {
      const vault = await prisma.automationVault.findUnique({ where: { provider: "builtin" } });
      if (vault?.key) {
        (zai as unknown as { config: { apiKey: string } }).config.apiKey = vault.key;
        console.log(
          `[autopilot] using vault key for "builtin" (updated ${vault.updatedAt.toISOString()})`
        );
      }
    } catch (vaultErr) {
      console.warn(
        "[autopilot] vault lookup failed — using built-in key:",
        vaultErr instanceof Error ? vaultErr.message : String(vaultErr)
      );
    }
    let chain = "";
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      await prisma.automationRun.update({
        where: { id: run.id },
        data: { currentStep: i + 1 },
      });
      const system =
        `You are "${s.agentName ?? "the executor"}" running step ${i + 1}/${steps.length} ` +
        `("${s.label}") of the autonomous pipeline "${wf.name}". ` +
        `Produce the step deliverable directly and completely. Do NOT ask questions, do NOT ` +
        `offer options, do NOT ask permission, do NOT promise future work — output the ` +
        `finished artifact for this step now.`;
      const user = [
        wf.task ? `PIPELINE TASK:\n${wf.task}` : "",
        s.prompt ? `STEP INSTRUCTIONS:\n${s.prompt}` : "",
        chain ? `PRIOR STEP OUTPUTS (most recent last):\n${chain}` : "",
      ]
        .filter(Boolean)
        .join("\n\n");

      const t0 = Date.now();
      // 3 attempts per step (mirrors the client runner's MAX_STEP_ATTEMPTS=3):
      // attempt-2/3 land on a fresh dial after backoff — a transient 429/5xx
      // from the engine must not kill a headless run that fires unattended.
      let out = "";
      let lastErr: unknown = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const completion = await zai.chat.completions.create({
            messages: [
              { role: "system", content: system },
              { role: "user", content: user.slice(0, 24_000) },
            ],
          });
          out = completion.choices[0]?.message?.content ?? "";
          if (out.trim().length > 0) break;
          lastErr = new Error("empty completion");
        } catch (e) {
          lastErr = e;
          console.warn(
            `[autopilot] run ${run.id} step ${i + 1} attempt ${attempt} failed:`,
            e instanceof Error ? e.message : String(e)
          );
        }
        if (attempt < 3) {
          // v21: a rate-limited attempt gets a longer cool-down — retrying a
          // 429 after 5s just burns the ladder on the same congestion.
          const rl = isRateLimit(lastErr);
          await new Promise((r) =>
            setTimeout(r, attempt === 1 ? (rl ? 20_000 : 5_000) : rl ? 45_000 : 15_000)
          );
        }
      }
      if (out.trim().length === 0) throw lastErr ?? new Error("step produced no output");
      const ms = Date.now() - t0;
      outputs.push({ label: s.label, output: out, ms, ok: true });
      chain = outputs
        .map((o) => `--- ${o.label} ---\n${o.output.slice(0, 4_000)}`)
        .join("\n\n")
        .slice(-16_000);
      await prisma.automationRun.update({
        where: { id: run.id },
        data: { stepsJson: JSON.stringify(outputs) },
      });
      console.log(`[autopilot] run ${run.id} step ${i + 1}/${steps.length} done in ${ms}ms`);
    }
    await prisma.automationRun.update({
      where: { id: run.id },
      data: {
        status: "done",
        finishedAt: new Date(),
        finalReport: outputs[outputs.length - 1]?.output ?? null,
      },
    });
    await prisma.automationWorkflow.update({
      where: { id: wf.id },
      data: { lastRunAt: new Date(), failStreak: 0 },
    });
    console.log(`[autopilot] run ${run.id} DONE — "${wf.name}"`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await prisma.automationRun.update({
      where: { id: run.id },
      data: { status: "error", error: msg, finishedAt: new Date(), stepsJson: JSON.stringify(outputs) },
    });
    const streak = wf.failStreak + 1;
    const rl = isRateLimit(e);
    const transient = rl || isTransient(e);
    // v21: tick already claimed nextRunAt = now+interval BEFORE executing.
    // A rate-limited run (environmental congestion) pushes the next attempt
    // further out — failStreak-scaled, capped 10min — so a congested gateway
    // is waited out, not hammered on every tick.
    // r116: ALL transient errors get the pushed-out backoff AND never pause
    // the schedule — only hard failures count toward the 3-strike breaker.
    await prisma.automationWorkflow.update({
      where: { id: wf.id },
      data: {
        lastRunAt: new Date(),
        failStreak: streak,
        enabled: transient ? true : streak < 3,
        ...(transient
          ? { nextRunAt: new Date(Date.now() + Math.max(60_000, wf.intervalMs) + rateLimitBackoffMs(streak)) }
          : {}),
      },
    });
    console.error(`[autopilot] run ${run.id} ERROR — "${wf.name}": ${msg}${transient ? " (transient — schedule kept enabled, next attempt pushed out)" : ""}`);
  }
}

async function tick(): Promise<void> {
  try {
    if (await clientAlive()) return; // tab is open → client scheduler drives (BYOK lane)
    const due = await prisma.automationWorkflow.findMany({
      where: { enabled: true, nextRunAt: { lte: new Date() } },
    });
    let slot = 0;
    for (const wf of due) {
      if (inFlight.has(wf.id)) continue;
      const interval = Math.max(60_000, wf.intervalMs);
      // Claim BEFORE running — a slow run can never double-fire on the next tick
      // (the delayed execution below is still covered by the claim).
      await prisma.automationWorkflow.update({
        where: { id: wf.id },
        data: { nextRunAt: new Date(Date.now() + interval) },
      });
      inFlight.add(wf.id);
      // v21/r116: stagger simultaneous claims 5s apart (was 2s — too tight
      // after a downtime backlog: 3 schedules firing within 4s congested the
      // shared gateway live at 11:25Z). N due workflows must not herd.
      const delay = slot++ * 5_000;
      setTimeout(() => {
        void executeRun(wf, "schedule").finally(() => inFlight.delete(wf.id));
      }, delay);
    }
  } catch (e) {
    console.error("[autopilot] tick error", e);
  }
}

console.log(
  "[autopilot] headless workflow scheduler up — tick 30s ±20% jitter, stand-down while tab heartbeats (<2min stale fires)"
);
// v21: jittered self-rescheduling loop — a fixed 30s interval aligns with every
// other 30s-cadence process (watchdogs, heartbeats, patrol curls); jitter
// desynchronizes them so due runs land on free seconds.
const loop = () => {
  void tick().finally(() => {
    const jitter = Math.round((Math.random() * 2 - 1) * TICK_MS * TICK_JITTER);
    setTimeout(loop, TICK_MS + jitter);
  });
};
loop();
