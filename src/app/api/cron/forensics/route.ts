import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { execFile } from "child_process";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ─── Cron fleet forensics (rebuilt post r30-restore) ────────────────────────
// Lost with the pre-recycle working tree; rebuilt from doctrine. Serves the
// 30-min patrol as the fallback fleet-verification path when the cron CLI is
// unavailable in-session, and powers the sidebar fleet chip.

const OPS_DIR = path.join(process.cwd(), "ops");

type JobEntry = {
  platformJobId?: string;
  name?: string;
  kind?: string;
  enabled?: boolean;
  schedule?: unknown;
};
type JobsFile = { jobs?: JobEntry[]; bannedKinds?: string[] };

async function readJsonSafe(p: string): Promise<JobsFile | null> {
  try {
    return JSON.parse(await fs.readFile(p, "utf8")) as JobsFile;
  } catch {
    return null;
  }
}

async function readLastLinesSafe(p: string, n: number): Promise<string[]> {
  try {
    return (await fs.readFile(p, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .slice(-n);
  } catch {
    return [];
  }
}

function probeCli(): Promise<{ available: boolean; output?: string; error?: string }> {
  return new Promise((resolve) => {
    try {
      execFile("cron", ["list"], { timeout: 5000 }, (err, stdout) => {
        if (err) {
          resolve({
            available: false,
            error: String((err as NodeJS.ErrnoException).code ?? err.message).slice(0, 80),
          });
        } else {
          resolve({ available: true, output: String(stdout).slice(0, 2000) });
        }
      });
    } catch (e) {
      resolve({ available: false, error: String(e).slice(0, 80) });
    }
  });
}

export async function GET() {
  const [registry, heartbeat, cli] = await Promise.all([
    readJsonSafe(path.join(OPS_DIR, "cron.jobs.json")),
    readLastLinesSafe(path.join(OPS_DIR, "heartbeat.log"), 5),
    probeCli(),
  ]);

  const jobs = (registry?.jobs ?? []).map((j) => ({
    platformJobId: j.platformJobId,
    name: j.name,
    kind: j.kind,
    enabled: j.enabled ?? true,
    schedule: j.schedule,
  }));

  return NextResponse.json({
    ok: true,
    generatedAt: new Date().toISOString(),
    registry: { source: "ops/cron.jobs.json", jobs },
    heartbeat: { source: "ops/heartbeat.log", last: heartbeat },
    cli,
    doctrine: [
      "kind=webDevReview is BANNED (forensics: 10/10 deaths via max_rounds_exceeded) — recreate missing jobs with kind=agentTurn ONLY.",
      "Recreate MISSING jobs only, EXACTLY from ops/cron.jobs.json jobs[]; dedupe by platformJobId — never duplicate a job that is still firing.",
      "When the cron CLI is unavailable in-session, verify the fleet via double-fire evidence: the patrol's own scheduled firing proves its platform job is alive.",
    ],
    note: "Rebuilt 2026-09-26 after the sandbox was restored from the GitHub backup at r30 (pre-recycle r31+ working tree was lost with it).",
  });
}
