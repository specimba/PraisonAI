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
`automation-bridge.tsx`). The server stands down while that heartbeat is fresh.

**Server lane (headless).** When the heartbeat goes stale (>120s — tab closed,
machine asleep, or the tab busy), the server lane takes over: a scheduler
mini-service claims due workflows (`nextRunAt <= now`), dials the LLM, and
writes `automationRun` rows. Two honest caveats: the mini-service itself is
**external to this repo** (this repo owns the registry, the run rows, the HTTP
contract, and all UI — not the claimer loop), and by default its runs dial the
built-in engine's shared gateway lane, which is congested (the r109-era 429
storms). That default is exactly what the Automation Vault fixes.

## The Automation Vault

An opt-in, local-only key slot for the headless lane. Store a key and
closed-tab runs dial with your quota instead of the shared lane.

- **Storage:** one row in the local SQLite DB (`AutomationVault`). Nothing is
  telemetered. `GET /api/vault` never returns the raw key — only a masked
  preview (`first4••••last4` for keys longer than 12 chars, otherwise `••••••••`).
- **UI:** Settings → *Automation vault* card. Store / Update / Remove, plus:
- **Test key:** dials `POST /api/vault/consume` exactly as the external
  scheduler would, then round-trips the returned raw key through the same
  `mask()` and compares it with the displayed preview. A match proves the
  handoff endpoint is reachable, the slot is readable, and the key is intact —
  without ever rendering the raw key. It does **not** dial an LLM (the built-in
  lane is environment-credentialed in-repo; dialing with the key is the
  external scheduler's job).
- **Status at a glance:** the *Server autopilot* panel (top of the Workflows
  view) shows a chip — cyan "headless lane: your key <mask>" or amber
  "headless lane: shared lane" — and clicking it deep-links to the vault card.

## HTTP contract (all localhost)

| Method & path | Caller | Behaviour |
| --- | --- | --- |
| `POST /api/automation/sync` | open tab, every 60s | Heartbeat + push enabled schedules. A push with ≥1 enabled schedule prunes orphaned registry rows; an empty push is heartbeat-only (protects against a second client disarming the registry). |
| `GET /api/automation/sync` | Server autopilot panel (15s poll) & drivers | `{ serverDriving, lastSeenAt, registry, runs[last 25], vaultLane { hasKey, maskedKey, updatedAt } }`. `serverDriving` = heartbeat stale >120s. |
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
