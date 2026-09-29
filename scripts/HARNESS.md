# E2E Harness — Stall-Failover & Lane QA Recipes

Consolidated doctrine for browser-direct vs server-relay QA rounds (epic v4→v16).
Read this BEFORE attempting a capture round — recipes were historically re-derived
from worklog.md each attempt and cost budget.

## Round-budget doctrine
- Patrol budget 8 rounds, review budget 12. Exceeding kills the recurring job.
- Visual-capture rounds historically overrun (r94: 13/12). Early clean exit is a SUCCESS.
- Never run builds or heavy suites. Verify via live HMR + console scan + health curl only.

## Canonical route recipe (r95+)
1. `agent-browser open http://localhost:3000`
2. Click the **"Workflows" client-side nav button** (sidebar). `/workflows` as a URL is **404** — root is the dashboard menu.
3. Probe card ("Stall Probe v4") renders **in-panel after reload-to-hydrate**. If the card is missing, reload root once, re-click Workflows, re-snapshot.

## Injection — inject-v8.js is the ONLY valid injector
- `inject-v4.js` / `inject-v7.js` are BROKEN (falsified): they wrote envelope-root
  mirror keys (`state.provider` etc.) that the store IGNORES. Real Settings live at
  `state.settings.*` inside the zustand-persist envelope.
- What inject-v8 does (verify before trusting — read the file):
  - Backs up `praison-settings` → `praison-bak-settings` (atomic-restore anchor)
  - Sets `provider=custom`, `baseUrl=http://localhost:4319/v1`, `defaultModel=hang-test`
  - Disables relay (`relayEnabled=false`) so the FIRST dial is browser-direct
  - Sets `praison-stall-timeout-ms=20000` (watchdog window)
  - Also touches `praison-agents` (backs up → `praison-bak-agents`)
- Execute via `agent-browser eval "$(cat scripts/inject-v8.js)"` after opening root.

## hang-server
- `bun scripts/hang-server.ts` — stalling stream server on **port 4319**.
- Start it BEFORE the run; it never answers, so the runner watchdog aborts at ~20s
  with: `no model output for over Ns — the stream stalled`.

## start-v4-run.sh — PARTIALLY STALE
- The h3-at-root probe-card recipe inside it is STALE (pre-r95 route map).
- Still useful: the dialog fill + enabled-Run-button click steps (textarea value
  setter + input event, `[role=dialog]` scoping).
- Route steps: replace with the canonical recipe above.

## Expected E2E arc (v9/v10 behavior)
1. Run dials browser-direct → hang-server stalls → runner watchdog aborts (~20s).
2. v10 classification: watchdog reason matches `isWatchdogAbortReason` → NOT a user
   cancel → fallback lane engages with a clean (signal-stripped) relay call.
3. Relay leg dials `/api/chat` (network count 0→1) → **SSRF guard rejects
   `http://localhost:4319` BY DESIGN** (`route.ts:120` — non-public-https).
   The rejection copy shown to the user is the honest terminal surface, not a bug.
4. Surfaces to capture: v11 "Retry via relay" button (sky accent since v15),
   v11b per-call lane notes (⇄ sky / ↻ amber), v13 lane-ratio chip in the call
   summary, v15 recovery card glow + ping + error copy-button, v14 chat header
   chip, v17 sidebar lane dots, v16 export receipts.

## Unit test
- `bun scripts/test-v9-abort.ts` → **17 checks, 0 fail** is green
  (r95 worklog text once said "18/18" — off-by-one typo; the suite is 17).

## Atomic state-restore doctrine (zero residue)
1. Restore from bak keys (`praison-bak-settings` → `praison-settings`, same for
   agents/workflows) via agent-browser eval.
2. Reload → verify state (provider/baseUrl back to user values).
3. ONLY THEN delete the bak keys.
4. Re-verify zero `praison-bak-*` keys remain. Never delete baks before verify.

## QA console scan
`agent-browser console | grep -iE "error|warn|failed"` — HMR/Fast-Refresh info
noise is expected and fine; anything else is a finding.
