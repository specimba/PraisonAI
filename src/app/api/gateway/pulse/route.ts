import { NextResponse } from "next/server";
import { gatewayPulse } from "@/lib/server/gateway-pulse";

export const dynamic = "force-dynamic";

// ─── Gateway pulse (r161) ────────────────────────────────────────────────────
// Read-only view of upstream 429s the SERVER observed on completion dials
// (agent-engine). Feeds the workflows view's ambient gateway chip so the
// question "is the shared gateway congesting?" is answerable without
// pasting the whole UI. See src/lib/server/gateway-pulse.ts for the honest
// scope (server-seen dials only; browser-direct keys are invisible here).

export async function GET() {
  return NextResponse.json(gatewayPulse());
}
