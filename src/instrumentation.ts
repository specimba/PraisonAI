// r204 — Next.js instrumentation hook (Local Automation Vault epic).
// Boots the server-side claim loop exactly once per server process: when the
// open tab's heartbeat goes stale (>120s), due AutomationWorkflow rows are
// claimed and executed through the opt-in local vault key (BYOK preserved —
// see src/lib/server/automation-executor.ts for the full contract).
//
// While the tab is open the loop stands down entirely; the client scheduler
// keeps driving with keys that never leave the browser.

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startAutomationExecutor } = await import("@/lib/server/automation-executor");
  startAutomationExecutor();
}
