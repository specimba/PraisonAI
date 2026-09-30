#!/usr/bin/env node
// r153: zero-import dependency scan — flags dependencies never imported in first-party code.
// Scope: src/, scripts/, plus root config files. Report-only (acting is a per-round decision).
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const deps = Object.keys(pkg.dependencies || {});

// Collect candidate source files: src/ + scripts/ recursively, root configs.
const files = [];
const walk = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", ".next", ".git", "ops"].includes(e.name)) continue;
    const p = join(dir, e.name);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(ts|tsx|js|jsx|mjs|mts|json|css)$/.test(e.name)) files.push(p);
  }
};
walk("src");
walk("scripts");
for (const f of ["next.config.ts", "next.config.js", "tailwind.config.ts", "tailwind.config.js", "postcss.config.mjs", "prisma/schema.prisma", "components.json"]) {
  try { if (statSync(f).isFile()) files.push(f); } catch {}
}
const corpus = files.map((f) => { try { return readFileSync(f, "utf8"); } catch { return ""; } }).join("\n");

const unused = [];
for (const d of deps) {
  // bare name for scoped packages: "@radix-ui/react-x" matches "from \"@radix-ui/react-x\"" and any deeper subpath
  const esc = d.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`["']${esc}(/[^"']*)?["']`);
  if (!re.test(corpus)) unused.push(d);
}
console.log(`deps scanned: ${deps.length}`);
console.log(`zero-import candidates (${unused.length}):`);
for (const d of unused) console.log(`  - ${d}`);
