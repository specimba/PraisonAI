// r151 QA — parseTrackerMirror contract (run: bun scripts/qa-tracker-mirror.ts)
// The corrupt-cache healing path in model-ticker boots from this parser, so its
// three-way verdict (data / corrupted / empty) must be exact.
import { parseTrackerMirror } from "../src/lib/tracker-types";

let pass = 0;
let fail = 0;
function ok(cond: boolean, name: string) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}`);
  }
}

// ── empty / corrupt verdicts ────────────────────────────────────────────────
ok(parseTrackerMirror(null).kind === "empty", "null → empty (no cache row)");
ok(parseTrackerMirror("{not json").kind === "corrupted", "garbage JSON → corrupted");
ok(parseTrackerMirror("").kind === "corrupted", "empty string → corrupted");
ok(parseTrackerMirror("null").kind === "corrupted", "JSON null root → corrupted");
ok(parseTrackerMirror("[]").kind === "corrupted", "array root → corrupted (no tracked)");
ok(parseTrackerMirror("{}").kind === "corrupted", "object without tracked → corrupted");
ok(parseTrackerMirror('{"tracked":"x"}').kind === "corrupted", "tracked not an array → corrupted");
ok(parseTrackerMirror('"hi"').kind === "corrupted", "string root → corrupted");

// ── valid mirror round-trips ────────────────────────────────────────────────
const row = {
  id: "a::b", providerId: "a", modelId: "b", displayName: null,
  contextWindow: 128_000, priceIn: 0, priceOut: 0, free: true,
  sightings: 3, isNew: true, firstSeenAt: "2026-09-30T00:00:00Z",
  lastSeenAt: "2026-09-30T01:00:00Z", removedAt: null, meta: null,
};
const good = JSON.stringify({
  at: Date.now(),
  tracked: [row],
  events: [{ id: "e1", type: "new", modelKey: "a::b", providerId: "a", modelId: "b", payload: null, createdAt: "2026-09-30T01:00:00Z" }],
  lastSyncAt: "2026-09-30T02:00:00Z",
});
const boot = parseTrackerMirror(good);
ok(boot.kind === "data", "valid mirror → data");
if (boot.kind === "data") {
  ok(boot.data.tracked.length === 1 && boot.data.tracked[0].id === "a::b", "tracked preserved");
  ok(boot.data.status.lastSyncAt === "2026-09-30T02:00:00Z", "lastSyncAt preserved");
  ok(boot.data.events.length === 1, "events preserved");
  ok(boot.data.status.stale === false, "fresh at → stale false");
} else {
  ok(false, "expected data boot for valid mirror");
}

// ── defaults on a minimal (but structurally valid) mirror ───────────────────
const minimal = parseTrackerMirror(JSON.stringify({ at: 0, tracked: [row] }));
ok(minimal.kind === "data", "minimal mirror → data");
if (minimal.kind === "data") {
  ok(minimal.data.events.length === 0, "missing events → []");
  ok(minimal.data.status.lastSyncAt === null, "missing lastSyncAt → null");
  ok(minimal.data.status.stale === true, "at=0 → stale true (ancient cache)");
} else {
  ok(false, "expected data boot for minimal mirror");
}

console.log(`\n${pass}/${pass + fail} assertions pass`);
console.log(`SUMMARY: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
