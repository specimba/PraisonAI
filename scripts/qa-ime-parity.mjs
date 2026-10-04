#!/usr/bin/env node
// ─── X-series (r245): static IME/Enter parity checker ────────────────────────
// Invariant (established r244 in test-agent-dialog, swept across src/ in
// r245): every keydown handler that compares e.key === "Enter" must reference
// isComposing within ±5 lines, OR the line itself must be inherently safe:
//   - modifier combos (metaKey/ctrlKey/altKey) — IME confirm is PLAIN Enter
//   - space-activation (e.key === " ") — card/button activation, not a text
//     input, so no composition can be in progress on that element
// Any NEW unguarded Enter handler added to src/ fails this check, which is
// exactly how the r244 test-dialog bug and the r245 sweep targets slipped in.
// Escape-during-composition is advisory only (softer UX class) and is NOT
// enforced here — Enter is the hard, send/jump/accept class of bug.
// Usage: node scripts/qa-ime-parity.mjs   (exit 1 on any violation)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../src", import.meta.url));
const WINDOW = 5;
const ENTER_RE = /e\.key === ["']Enter["']/;
const SAFE_LINE_RES = [
  { re: /(metaKey|ctrlKey|altKey)/, reason: "modifier combo — IME confirm is plain Enter" },
  { re: /e\.key === ["'] ["']/, reason: "space activation, not a text input" },
];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx|ts)$/.test(name)) out.push(p);
  }
  return out;
}

let checked = 0;
let failed = 0;
for (const file of walk(ROOT)) {
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    if (!ENTER_RE.test(line)) return;
    checked++;
    if (SAFE_LINE_RES.some(({ re }) => re.test(line))) return; // inherently safe
    const from = Math.max(0, i - WINDOW);
    const near = lines.slice(from, i + WINDOW + 1).join("\n");
    if (!near.includes("isComposing")) {
      failed++;
      console.error(`IME-PARITY FAIL ${file}:${i + 1}`);
      console.error(`   ${line.trim()}`);
    }
  });
}
console.log(
  `SUMMARY: ${checked - failed} passed, ${failed} failed (Enter handlers across src/, window ±${WINDOW})`,
);
process.exit(failed === 0 ? 0 : 1);
