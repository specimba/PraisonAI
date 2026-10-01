"use client";

import * as React from "react";
import { RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { fmtRel } from "@/lib/helpers";

// ─── Gateway pulse chip (r161) ───────────────────────────────────────────────
// Ambient answer to "is the shared gateway congesting?" on the workflows
// view — the surface where schedules show "next in Xm" and runs park on
// 429s (r158). Reads what the SERVER saw on completion dials via
// /api/gateway/pulse; the browser-side cadence/park state deliberately
// stays client-only, so this is the one signal that survives tab deaths
// and is readable cross-round via curl.
//
// Egress doctrine (r159 R5): ONE fetch per view mount, plus an explicit
// click-to-refresh on the chip itself — no polling. Renders NOTHING while
// the gateway has been clear for 24h (silence = healthy; a permanently
// green chip is noise, mirroring the CacheStatus decision in r160).

interface Pulse {
  last429At: number | null;
  count1h: number;
  count24h: number;
  recent: { t: number; model: string }[];
}

/** Fresh enough to warn about — inside this window the chip turns amber
 * (matches the client-side 90s quiet window's order of magnitude, with
 * headroom for the minutes-long saturation windows r158 measured). */
const FRESH_MS = 10 * 60_000;
/** Older than a day and the congestion is history — render nothing. */
const HIDE_MS = 24 * 60 * 60_000;

export function GatewayPulse() {
  const [pulse, setPulse] = React.useState<Pulse | null>(null);
  const [busy, setBusy] = React.useState(false);

  const fetchPulse = React.useCallback(async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/gateway/pulse", { cache: "no-store" });
      if (res.ok) setPulse((await res.json()) as Pulse);
    } catch {
      /* server briefly down — keep the previous (or empty) state silently */
    } finally {
      setBusy(false);
    }
  }, []);

  // One-shot per mount (egress doctrine) — refresh is explicit on the chip.
  React.useEffect(() => {
    void fetchPulse();
  }, [fetchPulse]);

  const fresh =
    pulse?.last429At != null && Date.now() - pulse.last429At < FRESH_MS;
  const recent = pulse?.last429At != null && Date.now() - pulse.last429At < HIDE_MS;

  if (!pulse || !recent || pulse.last429At == null) return null;

  const recentLines = pulse.recent
    .slice()
    .reverse()
    .map((e) => `· ${e.model || "unknown model"} — ${fmtRel(e.t)}`)
    .join("\n");
  const title = `Upstream 429s the server observed on completion dials (chat turns, workflow steps, autopilot — server-seen only; browser-direct keys are invisible here).\n\n${recentLines}\n\nClick to refresh.`;

  return (
    <button
      type="button"
      onClick={() => void fetchPulse()}
      aria-label={`Gateway pulse: last rate limit ${fmtRel(pulse.last429At)}, ${pulse.count24h} in the last 24 hours. Click to refresh.`}
      title={title}
      className={cn(
        "inline-flex w-fit cursor-pointer items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-medium transition-colors",
        fresh
          ? "border-amber-500/40 bg-amber-500/10 text-amber-600 hover:bg-amber-500/20 dark:text-amber-400"
          : "border-border bg-muted/40 text-muted-foreground hover:bg-muted/60"
      )}
    >
      <span
        aria-hidden
        className={cn(
          "h-1.5 w-1.5 rounded-full",
          fresh ? "animate-pulse bg-amber-500" : "bg-muted-foreground/50"
        )}
      />
      gateway 429 · last {fmtRel(pulse.last429At)} · {pulse.count24h} in 24h
      <RefreshCw
        aria-hidden
        className={cn("h-2.5 w-2.5 opacity-50", busy && "animate-spin")}
      />
    </button>
  );
}
