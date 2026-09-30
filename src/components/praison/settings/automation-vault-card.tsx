"use client";

// ─── v25: Automation Vault (Settings card) ───────────────────────────────────
// Opt-in, LOCAL-ONLY key slot for the headless server lane. While a tab is
// open, schedules run in-browser with the user's own keys (BYOK — keys never
// leave the browser). When the tab is CLOSED, the local server fires the same
// schedules headlessly; without a vault key those runs dial the shared
// built-in gateway (congested — the r109-era 429 storms). A key stored here
// (local SQLite only, nothing telemetered) lets closed-tab runs use the
// user's own quota instead. GET never returns the raw key — masked preview.

import * as React from "react";
import {
  Eye,
  EyeOff,
  FlaskConical,
  KeyRound,
  Loader2,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface VaultSlot {
  provider: string;
  label: string | null;
  maskedKey: string;
  updatedAt: string;
}

const PROVIDER_LABELS: Record<string, string> = {
  builtin: "Built-in engine (headless lane)",
};

export function AutomationVaultCard() {
  const [slots, setSlots] = React.useState<VaultSlot[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [key, setKey] = React.useState("");
  const [showKey, setShowKey] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [testing, setTesting] = React.useState(false);
  const [confirmRemove, setConfirmRemove] = React.useState(false);

  const load = React.useCallback(async () => {
    try {
      const res = await fetch("/api/vault");
      const json = (await res.json()) as { vault?: VaultSlot[] };
      setSlots(Array.isArray(json.vault) ? json.vault : []);
    } catch {
      /* local server briefly unreachable — keep last known slots */
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const builtin = slots.find((s) => s.provider === "builtin");

  async function save() {
    if (!key.trim()) {
      toast.error("Paste a key first — the vault stores exactly what you paste.");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/vault", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "builtin", key: key.trim() }),
      });
      const json = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !json.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setKey("");
      setShowKey(false);
      setConfirmRemove(false);
      await load();
      toast.success("Vault key stored — closed-tab runs will dial with it.", {
        description: "Local SQLite only. Nothing leaves this machine.",
      });
    } catch (e) {
      toast.error("Could not store the key", {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!confirmRemove) {
      setConfirmRemove(true);
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/vault?provider=builtin", { method: "DELETE" });
      const json = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !json.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      await load();
      toast.success("Vault key removed — headless runs fall back to the built-in lane.");
    } catch (e) {
      toast.error("Could not remove the key", {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setSaving(false);
      setConfirmRemove(false);
    }
  }

  // r135: the vault epic's verify affordance (descoped in r132 when the key
  // had NO consumer to prove anything against). What this test verifies —
  // honestly: the EXACT handoff the external headless scheduler depends on.
  // It POSTs /api/vault/consume as the scheduler would, then round-trips the
  // returned raw key through the same mask() the API uses and compares with
  // the displayed masked preview. A match proves: endpoint reachable, slot
  // readable, key intact end-to-end. What it does NOT verify: a real LLM
  // dial — the builtin lane is environment-credentialed in-repo; dialing
  // with the key is the external scheduler's job. The raw key is never
  // rendered, never logged — only the masked form ever reaches the UI.
  async function testKey() {
    if (!builtin) return;
    setTesting(true);
    try {
      const res = await fetch("/api/vault/consume", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "builtin" }),
      });
      if (res.status === 404) {
        toast.error("No key to test", {
          description: "The vault slot vanished — store a key first.",
        });
        return;
      }
      const json = (await res.json()) as { ok?: boolean; key?: string; error?: string };
      if (!res.ok || !json.ok || typeof json.key !== "string" || json.key.length === 0) {
        throw new Error(json.error ?? `HTTP ${res.status}`);
      }
      const raw = json.key;
      const masked =
        raw.length > 12 ? `${raw.slice(0, 4)}••••${raw.slice(-4)}` : "••••••••";
      if (masked !== builtin.maskedKey) {
        toast.error("Key round-trip mismatch", {
          description:
            "The handoff endpoint returned a key that does not match the stored slot — re-store the key.",
        });
        return;
      }
      toast.success("Vault key verified", {
        description: `The headless handoff returns it intact (${masked}) — closed-tab runs will dial with it.`,
      });
    } catch (e) {
      toast.error("Key test failed", {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setTesting(false);
    }
  }

  return (
    <Card className="gap-4">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 shrink-0 text-cyan-500" aria-hidden />
          <CardTitle>Automation vault</CardTitle>
          <Badge variant="outline" className="border-cyan-500/40 text-cyan-600 dark:text-cyan-400">
            local-only
          </Badge>
        </div>
        <CardDescription>
          While a tab is open, schedules run in-browser with your own keys — they never
          leave the browser. When the tab is closed, the local server fires headlessly;
          store a key here and those runs use your quota instead of the congested shared
          lane. Stored in local SQLite, never telemetered, displayed masked.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            Reading vault…
          </p>
        ) : (
          <div className="rounded-lg border border-border/60 bg-muted/20 p-3">
            {builtin ? (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                <KeyRound className="h-3.5 w-3.5 shrink-0 text-cyan-500" aria-hidden />
                <span className="text-xs font-semibold">
                  {PROVIDER_LABELS[builtin.provider] ?? builtin.provider}
                </span>
                <span className="font-mono text-xs tabular-nums text-muted-foreground">
                  {builtin.maskedKey}
                </span>
                <span className="text-[10px] text-muted-foreground/70">
                  updated {new Date(builtin.updatedAt).toLocaleString()}
                </span>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                No vault key yet — closed-tab runs use the shared built-in lane (subject
                to rate limits).
              </p>
            )}
          </div>
        )}

        <div className="space-y-2">
          <Label htmlFor="vault-key" className="text-xs text-muted-foreground">
            Key for the built-in engine lane
          </Label>
          <div className="flex items-center gap-2">
            <div className="relative min-w-0 flex-1">
              <Input
                id="vault-key"
                type={showKey ? "text" : "password"}
                value={key}
                onChange={(e) => {
                  setKey(e.target.value);
                  setConfirmRemove(false);
                }}
                placeholder="paste the gateway key for headless runs"
                autoComplete="off"
                spellCheck={false}
                className="pr-9 font-mono text-xs"
              />
              <button
                type="button"
                onClick={() => setShowKey((v) => !v)}
                aria-label={showKey ? "Hide key" : "Show key"}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
              >
                {showKey ? (
                  <EyeOff className="h-3.5 w-3.5" aria-hidden />
                ) : (
                  <Eye className="h-3.5 w-3.5" aria-hidden />
                )}
              </button>
            </div>
            <Button
              type="button"
              onClick={save}
              disabled={saving || !key.trim()}
              className="shrink-0"
            >
              {saving ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              ) : (
                <KeyRound className="h-3.5 w-3.5" aria-hidden />
              )}
              {builtin ? "Update" : "Store"}
            </Button>
            {builtin ? (
              <Button
                type="button"
                variant="outline"
                onClick={testKey}
                disabled={testing || saving}
                title="Dials /api/vault/consume exactly as the external headless scheduler would, and verifies the stored key comes back intact — the raw key is never shown."
                className="shrink-0 border-cyan-500/40 text-cyan-600 transition-colors hover:bg-cyan-500/10 hover:text-cyan-600 dark:text-cyan-400"
              >
                {testing ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                ) : (
                  <FlaskConical className="h-3.5 w-3.5" aria-hidden />
                )}
                Test key
              </Button>
            ) : null}
            {builtin ? (
              <Button
                type="button"
                variant="outline"
                onClick={remove}
                disabled={saving}
                className="shrink-0 border-red-500/40 text-red-500 hover:bg-red-500/10 hover:text-red-500"
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden />
                {confirmRemove ? "Confirm remove" : "Remove"}
              </Button>
            ) : null}
          </div>
          <p className="text-[10px] leading-relaxed text-muted-foreground/70">
            The key is written to this machine&apos;s SQLite DB only. The chat/agent BYOK
            keys in Providers above stay browser-side and are unaffected. Removing the
            slot makes headless runs fall back to the built-in lane automatically.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
