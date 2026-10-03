# Local automation — the two-lane model & the vault

PraisonAI pipelines with recurring schedules run on one of two lanes. Which lane
is active is not a setting — it is decided by whether an open browser tab is
keeping a fresh heartbeat. This document describes both lanes, the Automation
Vault that feeds the headless lane, and the local HTTP contract every piece
relies on. Everything here is local-only: no telemetry, no cloud relay.

## The two lanes

**In-tab lane (BYOK).** While a tab is open, the client-side scheduler runs
schedules directly in the browser using the user's own provider keys — the same
keys the chat uses. Keys never leave the browser in this mode. Every 60 seconds
the tab pushes the enabled schedules plus a heartbeat to the server
(`POST /api/automation/sync`, `SYNC_INTERVAL_MS = 60_000` in
`src/components/praison/workflows/automation-bridge.tsx`). The server stands
down while that heartbeat is fresh.

The heartbeat's visibility behaviour is deliberate and is the mirror image of
the Server Autopilot panel's poll (r144/r145, documented in-code):

- **Hidden tabs keep heartbeating.** The POST is a *liveness claim* ("tab
  alive → server lane stands down"), not a data poll. Suppressing it while
  hidden would hand schedules to the shared built-in gateway the moment the
  user merely switches windows, so it is NOT paused on
  `visibilitychange`. Chromium's background throttling still bounds it to
  ≥1/minute, which satisfies the 120s staleness window by design.
- **Returning to a visible tab resyncs immediately.** Without this, the next
  fresh heartbeat could be up to 60s away and in that window the still-stale
  registration lets the headless lane claim a due run the tab lane is about
  to fire itself — the resync makes lane handback land the instant the user
  actually looks.

**Server lane (headless).** When the heartbeat goes stale (>120s — tab closed,
machine asleep, or the tab busy), the server lane takes over: a scheduler
mini-service claims due workflows (`nextRunAt <= now`), dials the LLM, and
writes `automationRun` rows. Two honest caveats: the mini-service itself is
**external to this repo** (this repo owns the registry, the run rows, the HTTP
contract, and all UI — not the claimer loop), and by default its runs dial the
built-in engine's shared gateway lane, which is congested (the r109-era 429
storms). That default is exactly what the Automation Vault fixes.

## The Automation Vault

Opt-in, local-only key slots for the headless lane. Store a key per provider
and closed-tab runs dial with your quota instead of the shared lane.

- **Storage:** one row **per provider** in the local SQLite DB
  (`AutomationVault`, `provider` is unique — a slot list, not a single slot).
  Nothing is telemetered. `GET /api/vault` never returns raw keys — only
  masked previews (`first4••••last4` for keys longer than 12 chars,
  otherwise `••••••••`).
- **Slot resolution (r207/r211):** the executor scans the slots **oldest
  first** (`createdAt` asc — the order the vault GET ships since r210) and
  the first resolvable slot wins: a slot with no key or no matching registry
  provider is skipped, and if no slot resolves the run is honestly reported
  as `no-vault-key` / `no-resolvable-provider`. The dial semantics have
  exactly one exported resolver (`resolveServerDialFromSlots`); the lane chip
  and the sync GET mirror it, so they cannot disagree.
- **Legacy `builtin` slot:** the built-in engine's gateway-key handoff is
  kept for older client bundles but the server executor **skips it** — it is
  a client-lane concept, not a headless credential.
- **UI:** Settings → *Automation vault* card — one row per provider slot with
  its stored age (the dial-order input, made visible), plus:
- **Test key:** per slot — dials `POST /api/vault/consume` exactly as the
  external scheduler would, then round-trips the returned raw key through the
  same `mask()` and compares it with the displayed preview. A match proves the
  handoff endpoint is reachable, the slot is readable, and the key is intact —
  without ever rendering the raw key. It does **not** dial an LLM (the built-in
  lane is environment-credentialed in-repo; dialing with the key is the
  external scheduler's job).
- **Reveal (r154):** the card's eye button on a stored-slot row dials the
  same `POST /api/vault/consume` and renders the raw key for ~8 seconds, then
  re-masks itself — immediate re-mask on second click / unmount / re-store,
  no auto-copy, and a reload re-masks (reveal state is never persisted).
  Threat model unchanged: the key is already plaintext in this machine's
  SQLite and `consume` is already reachable by any same-machine caller — the
  reveal changes who can *see* the key on screen, not who can programmatically
  *get* it.
- **Status at a glance:** the *Server autopilot* panel (top of the Workflows
  view) shows a lane chip — when the tab drives, "browser driving — schedules
  run in-tab (your keys)"; when the server lane is live, "server lane:
  <provider> <mask>" with the resolved slot — and the vault-related surfaces
  deep-link to the vault card.

## HTTP contract (all localhost)

| Method & path | Caller | Behaviour |
| --- | --- | --- |
| `POST /api/automation/sync` | open tab, every 60s | Heartbeat + push enabled schedules. A push with ≥1 enabled schedule prunes orphaned registry rows; an empty push is heartbeat-only (protects against a second client disarming the registry). |
| `GET /api/automation/sync` | Server autopilot panel (15s poll) & drivers | `{ serverDriving, lastSeenAt, registry, runs[last 25], executorLane, vaultLane }`. `serverDriving` = heartbeat stale >120s. `executorLane` (r205/r207) mirrors `resolveServerDialFromSlots` exactly — `{ ready, reason?, providerLabel, maskedKey, slotProvider, slotCount }` for the slot the executor will actually dial (live-verified r217); `vaultLane` is the legacy r133 builtin-slot read, kept one release for older cached bundles. The panel poll pauses while the tab is hidden and refetches on return (r141) — the deliberate mirror of the heartbeat's keep-hidden semantics. |
| `POST /api/automation/run-now` | UI ("Run on server") | Sets `nextRunAt = now` and re-enables the row; the external scheduler claims it within ~30s when it is driving. |
| `POST /api/vault` | Settings UI | Upsert `{ provider, key, label }` → masked ack. |
| `GET /api/vault` | Settings UI | Masked slots only — raw key never leaves the DB except through `consume`. |
| `DELETE /api/vault?provider=…` | Settings UI | Removes the slot; headless runs fall back to the shared lane automatically. |
| `POST /api/vault/consume` | external scheduler (and the Test key button) | `{ provider }` → `{ key, updatedAt }` — the raw key. **Localhost-only guard (enforced since r138):** non-local `Host`, non-local `x-forwarded-host`, non-loopback `x-forwarded-for` / `x-real-ip`, or any `forwarded` header ⇒ `403` before any key lookup — both legit callers dial localhost, so both pass. **Trust model:** the key is already plaintext in this machine's SQLite DB, so localhost HTTP adds no exposure while giving the service a stable, DB-agnostic contract. Never logged, never telemetered. The header guard is defense-in-depth, not auth — a LAN client can still spoof `Host`, so if this app is ever deliberately exposed beyond localhost, it **must** gain real auth first. |

## Reliability notes

- Errors in the server-run history are classified: transient infra noise
  (429 / rate-limit / socket blips / timeouts — `TRANSIENT_RE`) renders amber
  as "↻ retried" with retry backoff armed; only hard failures show the red
  terminal "✗ error".
- Run history rows with recorded LLM calls expose an "N calls" expander: the
  grouped per-step call log with global numbering and a counted resilience
  digest (`↻ primary skipped ×N · ⇄ model substitution ×N · ⇄ relay rotation ×N`).
- **Failure breaker (server side):** three straight failed closed-tab runs
  park a registry row (`enabled: false, failStreak ≥ 3`) instead of burning
  more quota. Parked rows render in the autopilot panel's red strip (r216)
  with the resume advice; the pulse's attention cell deep-links to the first
  offender's remediation surface (stale >24h → the amber strip, breaker-parked
  → the red strip, lane-blocked due run → the vault card) — each surface
  renders from the same data source as the count it explains (r212/r216).
- **Stale registry:** an enabled schedule overdue >24h with neither lane
  claiming it renders the amber strip in the autopilot panel (re-enable the
  schedule, store a vault key, or use "Run on server").

---

Fact-checked against code as of r217 (2026-10-03), re-stamped after the
r205–r216 vault/lane/diagnostics work: `SYNC_INTERVAL_MS = 60_000`,
`HEARTBEAT_STALE_MS = 120_000` (both the bridge and the sync route),
`GET /api/automation/sync` response shape **including the r205 `executorLane`
field and the legacy `vaultLane`** (verified live against the dev server),
`take: 25` run history, the multi-slot `AutomationVault` model
(`provider @unique`, oldest-first dial order, `builtin` skipped by the
executor), the r138 consume-guard header list, the r154 reveal-once path
(consume reuse + 8s auto re-mask, now per slot), the vault card's per-slot
Test-key round-trip, `run-now`'s `nextRunAt + enabled: true`, the
`TRANSIENT_RE` timeout coverage, the digest strings in
`workflow-run-panel.tsx`, and the r212/r216 attention deep-link targets
(`automation-stale-strip`, `automation-parked-strip`, vault anchor). Future
rounds changing these endpoints should treat this file as part of the blast
radius.
