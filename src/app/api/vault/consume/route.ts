import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

// ─── v25/r133: Automation Vault consumer handoff ────────────────────────────
// The headless scheduler mini-service runs OUTSIDE this app (sandbox process,
// heartbeat-driven — see /api/automation/sync). When it claims a due workflow
// it dials LLM lanes directly and needs the user's stored vault key so
// closed-tab runs use the user's own quota instead of the congested shared
// lane. This endpoint is that handoff: POST { provider } → { key }.
//
// Trust model: the key already lives in this machine's SQLite DB in plain
// text — any same-host process can read it directly. Serving it over
// localhost HTTP adds no new exposure and gives the service a stable,
// DB-agnostic contract (it never touches Prisma/SQLite paths). The key is
// NEVER logged, never telemetered, and never returned by GET /api/vault
// (that stays masked-only).
//
// Response shapes:
//   200 { ok: true, provider, key, updatedAt }
//   404 { ok: false, error: "no vault key stored for this provider" }
//   400 { ok: false, error: "provider required" }

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as { provider?: string };
    const provider = (body.provider ?? "builtin").trim();
    if (!provider) {
      return NextResponse.json({ ok: false, error: "provider required" }, { status: 400 });
    }
    const row = await db.automationVault.findUnique({ where: { provider } });
    if (!row) {
      return NextResponse.json(
        { ok: false, error: `no vault key stored for provider "${provider}"` },
        { status: 404 }
      );
    }
    return NextResponse.json({
      ok: true,
      provider: row.provider,
      key: row.key,
      updatedAt: row.updatedAt,
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
