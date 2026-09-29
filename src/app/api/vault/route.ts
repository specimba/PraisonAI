import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

// ─── v25: Local Automation Vault ─────────────────────────────────────────────
// Opt-in storage for a user-chosen key the HEADLESS server lane may use when
// the tab is closed. The browser BYOK lane keeps keys client-side and never
// touches this. Local-first: the key lives only in this machine's SQLite DB,
// nothing is telemetered, and GET never returns the raw key — only a masked
// preview. POST upserts a slot; DELETE removes it.

const MASK_MIN = 12;
const maskKey = (k: string) =>
  k.length > MASK_MIN ? `${k.slice(0, 4)}••••${k.slice(-4)}` : "••••••••";

export async function GET() {
  try {
    const rows = await db.automationVault.findMany({ orderBy: { provider: "asc" } });
    return NextResponse.json({
      vault: rows.map((r) => ({
        provider: r.provider,
        label: r.label,
        maskedKey: maskKey(r.key),
        updatedAt: r.updatedAt,
      })),
    });
  } catch (e) {
    return NextResponse.json(
      { vault: [], error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { provider?: string; key?: string; label?: string };
    const provider = (body.provider ?? "builtin").trim();
    const key = (body.key ?? "").trim();
    if (!provider || !key) {
      return NextResponse.json(
        { ok: false, error: "provider and key are required" },
        { status: 400 }
      );
    }
    const row = await db.automationVault.upsert({
      where: { provider },
      create: { provider, key, label: body.label ?? null },
      update: { key, label: body.label ?? null },
    });
    return NextResponse.json({
      ok: true,
      provider: row.provider,
      maskedKey: maskKey(row.key),
      updatedAt: row.updatedAt,
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}

export async function DELETE(req: Request) {
  try {
    const provider = new URL(req.url).searchParams.get("provider") ?? "builtin";
    await db.automationVault.deleteMany({ where: { provider } });
    return NextResponse.json({ ok: true, provider });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
