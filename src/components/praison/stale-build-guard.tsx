"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

// r189 — stale-tab guard. Schedules fire IN THIS TAB with the bundle the tab
// loaded at page-open. Dev HMR dies silently in throttled background tabs, so
// the tab can keep running pre-fix scheduler/relay logic for hours after the
// fix shipped — exactly how the r185/r186 depth-degradation looked "not
// working" while the user's board kept materializing 0/11 deep runs. This
// guard polls the server's code-freshness stamp every 60s; when it changes
// (any edit under src/, or a server restart), it toasts once (sticky) and
// shows a floating pill until the user reloads.

export function StaleBuildGuard() {
  const [stale, setStale] = useState(false);
  const stamp = useRef<string | null>(null);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const r = await fetch("/api/version", { cache: "no-store" });
        if (!r.ok) return;
        const j = (await r.json()) as { stamp?: string };
        if (!alive || !j.stamp) return;
        if (stamp.current == null) {
          stamp.current = j.stamp;
        } else if (stamp.current !== j.stamp) {
          stamp.current = j.stamp;
          setStale(true);
          toast("App updated — this tab runs old code", {
            icon: "🔄",
            id: "stale-build",
            duration: Infinity,
            description:
              "The server picked up new changes (scheduler, relay ladder, fixes) after this tab loaded. Schedules keep firing the OLD logic until you refresh — click the pill to reload now.",
          });
        }
      } catch {
        /* server briefly unavailable — retry next tick */
      }
    };
    void poll();
    const t = setInterval(poll, 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  if (!stale) return null;
  return (
    <button
      type="button"
      onClick={() => window.location.reload()}
      aria-label="Refresh to load the updated app build"
      className="fixed bottom-4 right-4 z-50 flex items-center gap-2 rounded-full border border-amber-500/40 bg-amber-500/15 px-4 py-2 text-sm font-medium text-amber-700 shadow-sm backdrop-blur transition-colors hover:bg-amber-500/25 dark:text-amber-300"
    >
      <span className="relative flex h-2 w-2">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-500 opacity-60" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-amber-500" />
      </span>
      New build — refresh tab
    </button>
  );
}
