// ─── r223 QA: deleting the active chat lands on the sidebar's top row ────────
// The conversations store's remove() used to fall back to conversations[0] —
// CREATION order — while the sidebar sorts by updatedAt. Once an older chat is
// messaged after a newer one is created, the two orders diverge: you delete the
// active chat and land on a stale conversation while the sidebar's top row is a
// different chat. The fix: the fallback picks the most recently UPDATED
// remaining conversation (or null when none remain).
// Also guards the sibling design invariants that keep the list honest:
//   rename and togglePin must NOT bump updatedAt (no surprise reorder).
// Runs in bun against the real store (in-memory — localStorage is absent, so
// zustand persist no-ops and the process exits byte-clean; nothing to restore).
// Usage: bun scripts/qa-chat-store-fallback.ts
import { useConversationsStore } from "../src/lib/stores";
import type { ChatMessage } from "../src/lib/types";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { console.log(`${c ? "  ✓" : "  ✗"} ${m}`); if (c) pass++; else fail++; };

const s = () => useConversationsStore.getState();

const msg = (id: string, content: string): ChatMessage => ({
  id,
  role: "user",
  content,
  createdAt: Date.now(),
  toolCalls: [],
  status: "done",
});

/** Force deterministic updatedAt values — the whole suite runs inside one
 * millisecond of wall clock, and a stable sort breaks ties by creation order,
 * which is exactly the trap under test. */
const setUpdatedAt = (id: string, ts: number) =>
  useConversationsStore.setState((s) => ({
    conversations: s.conversations.map((c) => (c.id === id ? { ...c, updatedAt: ts } : c)),
  }));

// ── 1. The divergence the fix targets ────────────────────────────────────────
// Create B, create C (C becomes conversations[0] — creation-newest), then
// message B (B becomes update-newest), then create D (active = D).
// Remaining after deleting D: creation order [C, B] vs update order [B, C].
const bId = s().create();
const cId = s().create();
s().appendMessage(bId, msg("m1", "bump B"));
const dId = s().create();
// Deterministic clock: B updated most recently, C older, D (active) in between.
setUpdatedAt(bId, 5_000);
setUpdatedAt(cId, 3_000);
setUpdatedAt(dId, 4_000);
ok(s().conversations[0]?.id === dId, "D is creation-newest (conversations[0] before fix would win)");
ok(s().activeId === dId, "D is the active chat");
s().remove(dId);
const fallback = s().activeId;
ok(
  fallback === bId,
  `deleting the ACTIVE chat falls back to the most recently UPDATED chat (got ${fallback}, want ${bId})`,
);
ok(fallback !== cId, "fallback is NOT conversations[0] (creation order) — the old trap");

// ── 2. Removing a NON-active chat never touches activeId ─────────────────────
s().remove(cId);
ok(s().activeId === bId, "removing a non-active chat leaves activeId untouched");

// ── 3. Removing the last remaining chat → null ───────────────────────────────
s().remove(bId);
ok(s().conversations.length === 0 && s().activeId === null, "removing the last chat leaves activeId null");

// ── 4. Design guard: rename must NOT bump updatedAt (no surprise reorder) ────
const xId = s().create();
const yId = s().create();
const xBefore = s().conversations.find((c) => c.id === xId)!.updatedAt;
s().rename(xId, "renamed chat");
ok(
  s().conversations.find((c) => c.id === xId)!.updatedAt === xBefore,
  "rename keeps updatedAt (renamed chats do not jump to the top)",
);
ok(
  s().conversations.find((c) => c.id === xId)!.title === "renamed chat",
  "rename applies the title",
);

// ── 5. Design guard: togglePin must NOT bump updatedAt either ────────────────
s().togglePin(xId);
ok(
  s().conversations.find((c) => c.id === xId)!.updatedAt === xBefore,
  "togglePin keeps updatedAt (pinning does not reorder the un-pinned list)",
);

console.log(`\nqa-chat-store-fallback: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
