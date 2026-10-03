// r234 one-shot contract verifier for the sync API orphan guard
// (src/app/api/automation/sync/route.ts).
// Proves BOTH halves of the r234 contract live against the running server:
//   A) a disabled-only push is heartbeat-only — it must NOT disarm unrelated
//      enabled registry rows (pre-r234 bug: ANY non-empty push pruned, so a
//      cleanup POST of a single disabled row silently disarmed the user's
//      schedules);
//   B) a push carrying ≥1 enabled schedule still prunes orphans (v24 kept):
//      an enabled row missing from the sent set ends up disabled.
// Self-cleaning: only creates/toggles qa-r234* rows; user rows are only ever
// ECHOED back with their current enabled state, never toggled.
// Usage: node scripts/verify-r234-guard.mjs [baseUrl]
const BASE = process.argv[2] ?? "http://localhost:3000";
const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
};
const get = async () =>
  (await fetch(`${BASE}/api/automation/sync`, { cache: "no-store" })).json();
const post = async (rows) =>
  fetch(`${BASE}/api/automation/sync`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workflows: rows }),
  });
const qaRow = (id, name, enabled) => ({
  id,
  name,
  task: `r234 guard contract ${id}`,
  intervalMs: 900_000,
  enabled,
  steps: [],
});
// Faithful echo of an existing registry row (stepsJson → steps, enabled kept).
const echo = (r) => {
  let steps = [];
  try { steps = JSON.parse(r.stepsJson ?? "[]"); } catch {}
  return {
    id: r.id,
    name: r.name ?? r.id,
    task: r.task ?? "",
    intervalMs: Number(r.intervalMs) || 900_000,
    enabled: r.enabled === true,
    steps,
  };
};
const isQa = (r) => `${r.name ?? ""}${r.id ?? ""}`.includes("qa-r234");

const before = await get();
const rows = before?.registry ?? [];
const userRows = rows.filter((r) => !isQa(r));
const userEnabled = userRows.filter((r) => r.enabled === true);
check(
  "P0 registry reachable + preflight",
  before?.registry !== undefined && before?.ok !== false,
  `rows=${rows.length} userEnabled=${userEnabled.length}`,
);

// Seed the enabled victim (echo user rows so their countdowns stay intact).
let res = await post([...userRows.map(echo), qaRow("qa-r234-victim", "qa-r234 victim row", true)]);
let after = await get();
check(
  "P1 enabled victim seeded",
  res.ok && (after.registry ?? []).some((r) => r.id === "qa-r234-victim" && r.enabled === true),
);

// Contract A: disabled-only push (a lone disabled decoy row) — heartbeat only.
res = await post([qaRow("qa-r234-decoy", "qa-r234 decoy row", false)]);
after = await get();
const victim = (after.registry ?? []).find((r) => r.id === "qa-r234-victim");
check(
  "A1 disabled-only push does NOT disarm the enabled victim",
  res.ok && victim?.enabled === true,
  `victim.enabled=${victim?.enabled}`,
);
check(
  "A2 user rows untouched by the disabled-only push",
  (after.registry ?? []).filter((r) => !isQa(r) && r.enabled === true).length === userEnabled.length,
);

// Contract B: a push carrying ≥1 enabled schedule still prunes orphans.
// Echo every user-enabled row into the sent set so ONLY the victim is pruned.
res = await post([...userRows.map(echo), qaRow("qa-r234-pruner", "qa-r234 pruner row", true)]);
after = await get();
const victimAfter = (after.registry ?? []).find((r) => r.id === "qa-r234-victim");
check(
  "B1 enabled push prunes the orphaned victim row",
  res.ok && victimAfter?.enabled === false,
  `victim.enabled=${victimAfter?.enabled}`,
);
check(
  "B2 user rows still enabled after the prune",
  (after.registry ?? []).filter((r) => !isQa(r) && r.enabled === true).length === userEnabled.length,
);

// Cleanup: disable every qa-r234 row via the API's own disabled-path
// (echo user rows verbatim — sentIds covers everything, prune is a no-op).
const final = await get();
const all = final?.registry ?? [];
res = await post([
  ...all.filter((r) => !isQa(r)).map(echo),
  ...all.filter(isQa).map((r) => echo({ ...r, enabled: false })),
]);
const done = await get();
const qaLeft = (done.registry ?? []).filter((r) => isQa(r) && r.enabled === true);
check(
  "Z0 cleanup: zero enabled qa-r234 rows remain",
  res.ok && qaLeft.length === 0,
  qaLeft.map((r) => r.id).join(",") || "clean",
);

const failed = results.filter((x) => !x).length;
console.log(`\nSUMMARY: ${results.length - failed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
