import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

// ─── v20: Headless autopilot sync ────────────────────────────────────────────
// POST: the open tab pushes workflow snapshots (enabled schedules only) and
// heartbeats. While the heartbeat is fresh, the server stands down — the
// client scheduler drives runs with the user's own keys (BYOK lane).
// GET: the ServerAutopilot panel polls this for registry + recent server runs.

type StepPayload = { label: string; agentName?: string; prompt: string };
type WorkflowPayload = {
  id: string;
  name: string;
  task: string;
  intervalMs: number;
  enabled: boolean;
  steps: StepPayload[];
};

const HEARTBEAT_STALE_MS = 120_000;

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { workflows?: WorkflowPayload[] };
    const workflows = Array.isArray(body.workflows) ? body.workflows : [];

    // Heartbeat FIRST — a successful sync means the client is alive.
    await db.automationState.upsert({
      where: { id: "singleton" },
      create: { id: "singleton", lastSeenAt: new Date() },
      update: { lastSeenAt: new Date() },
    });

    for (const w of workflows) {
      const data = {
        name: w.name,
        task: w.task ?? "",
        stepsJson: JSON.stringify(w.steps ?? []),
        intervalMs: Math.max(60_000, Number(w.intervalMs) || 900_000),
        enabled: w.enabled !== false,
      };
      const existing = await db.automationWorkflow.findUnique({ where: { id: w.id } });
      if (existing) {
        // Preserve the countdown across syncs — re-registering must never
        // push a due run into the future (that would starve the schedule).
        await db.automationWorkflow.update({ where: { id: w.id }, data });
      } else {
        await db.automationWorkflow.create({
          data: { id: w.id, ...data, nextRunAt: new Date(Date.now() + data.intervalMs) },
        });
      }
    }

    // Orphan guard: registry rows the client no longer sends are disabled
    // (kept for run history, never deleted).
    // v24 collapse fix: a push with ZERO enabled schedules is NOT authoritative
    // — any second client (QA browser profile, a second tab before hydration)
    // would otherwise disarm the primary user's registry every heartbeat
    // (proven live 2026-09-29: the QA instance re-disabled all 4 rows every
    // 60s in a silent tug-of-war with the real tab). Empty push = heartbeat
    // only. A push with ≥1 enabled schedule still prunes orphans.
    if (workflows.length > 0) {
      const sentIds = new Set(workflows.map((w) => w.id));
      const all = await db.automationWorkflow.findMany({ select: { id: true, enabled: true } });
      for (const row of all) {
        if (!sentIds.has(row.id) && row.enabled) {
          await db.automationWorkflow.update({ where: { id: row.id }, data: { enabled: false } });
        }
      }
    }

    return NextResponse.json({ ok: true, registered: workflows.length });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}

export async function GET() {
  try {
    const [state, registry, runs] = await Promise.all([
      db.automationState.findUnique({ where: { id: "singleton" } }),
      db.automationWorkflow.findMany({ orderBy: { name: "asc" } }),
      db.automationRun.findMany({ orderBy: { startedAt: "desc" }, take: 25 }),
    ]);
    const lastSeen = state?.lastSeenAt?.getTime() ?? 0;
    return NextResponse.json({
      serverDriving: Date.now() - lastSeen > HEARTBEAT_STALE_MS,
      lastSeenAt: state?.lastSeenAt ?? null,
      registry,
      runs,
    });
  } catch (e) {
    return NextResponse.json(
      { serverDriving: false, registry: [], runs: [], error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
