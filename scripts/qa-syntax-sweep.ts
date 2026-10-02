/**
 * r200 — Cache-bypassing syntax sweep.
 *
 * Why this exists: r199 found a file (src/lib/spawn-proposal-engine.ts) whose
 * on-disk text could not parse AT ALL, yet every gate passed for months —
 * tsc (incremental tsbuildinfo), bun QA runs (transpiler cache) and Next dev
 * (module cache) all served CACHED parses of pre-corruption code. Any fresh
 * parse (clean clone, CI, cold checkout) would have failed to compile.
 *
 * This sweep gives ZERO caching surface:
 *   1. TypeScript compiler API: a brand-new SourceFile is parsed from the raw
 *      text on disk for every file; any parse diagnostic fails the run.
 *   2. Bun.Transpiler (fresh instance, per file): the same parser bun QA uses,
 *      invoked cold so its cache cannot mask a broken file.
 *
 * Scope: every .ts/.tsx/.mts/.cts/.js/.jsx/.mjs under src/ and scripts/.
 * Only SYNTAX (parse) diagnostics are checked — semantic errors (like the
 * known scripts/hang-server.ts one) are tsc's job, not this sweep's.
 *
 * Self-test: before scanning the tree, the script proves it can still detect
 * the exact r199 bomb shape (`candidatesashIndex(taskExcerpt) % ...];` —
 * undefined symbol + stray bracket). If detection regresses, the sweep fails
 * loudly instead of silently going blind.
 *
 * Run: bun run scripts/qa-syntax-sweep.ts
 * Exit: 0 = all files parse fresh; 1 = at least one file failed (report above).
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ts from "typescript";

// Minimal local ambient for the one Bun API we need — avoids a @types/bun
// dependency (which can conflict with the Next app's DOM/node types) while
// keeping tsc's baseline unchanged. Same class as scripts/hang-server.ts.
declare const Bun: {
  Transpiler: new (opts: { loader: "tsx" | "ts" | "js" | "jsx" }) => {
    transformSync(code: string): string;
  };
};

const ROOTS = ["src", "scripts"];
const EXTS_TS = new Set([".ts", ".tsx", ".mts", ".cts"]);
const EXTS_JS = new Set([".js", ".jsx", ".mjs"]);
const SKIP_DIRS = new Set(["node_modules", ".next", ".git", "coverage"]);

let failures = 0;
let scanned = 0;

function collectFiles(dir: string, out: string[]): void {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // root missing (e.g. no scripts dir) — nothing to sweep
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      collectFiles(full, out);
    } else if (entry.isFile()) {
      const dot = entry.name.lastIndexOf(".");
      if (dot === -1) continue;
      const ext = entry.name.slice(dot);
      if (EXTS_TS.has(ext) || EXTS_JS.has(ext)) out.push(full);
    }
  }
}

function scriptKindFor(file: string): ts.ScriptKind {
  if (file.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (file.endsWith(".ts") || file.endsWith(".mts") || file.endsWith(".cts"))
    return ts.ScriptKind.TS;
  if (file.endsWith(".jsx")) return ts.ScriptKind.JSX;
  return ts.ScriptKind.JS;
}

function bunLoaderFor(file: string): "tsx" | "ts" {
  return file.endsWith(".tsx") ? "tsx" : "ts";
}

interface ParseIssue {
  file: string;
  line: number;
  col: number;
  message: string;
  sourceLine: string;
}

function tsParseCheck(file: string, text: string): ParseIssue[] {
  const sf = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    scriptKindFor(file),
  );
  // parseDiagnostics is internal-but-stable; it is exactly what tsc reports
  // as syntax errors before any semantic analysis happens.
  const diags = (sf as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] })
    .parseDiagnostics ?? [];
  return diags.map((d) => {
    const pos = sf.getLineAndCharacterOfPosition(d.start ?? 0);
    const lineText = sf.text.split("\n")[pos.line] ?? "";
    return {
      file,
      line: pos.line + 1,
      col: pos.character + 1,
      message: ts.flattenDiagnosticMessageText(d.messageText, "\n"),
      sourceLine: lineText.trim().slice(0, 160),
    };
  });
}

function bunParseCheck(file: string, text: string): ParseIssue[] {
  try {
    const transpiler = new Bun.Transpiler({ loader: bunLoaderFor(file) });
    transpiler.transformSync(text);
    return [];
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return [{ file, line: 0, col: 0, message, sourceLine: "(bun transpiler) " + message.split("\n")[0]?.slice(0, 120) }];
  }
}

// ---------------------------------------------------------------------------
// Self-test: the sweep must still catch the r199 bomb shape, or it is blind.
// ---------------------------------------------------------------------------
function selfTest(): boolean {
  const bomb = `const candidates = ["a", "b"];\nconst taskExcerpt = "x";\nreturn candidatesashIndex(taskExcerpt) % candidates.length];\n`;
  const tsHits = tsParseCheck("self-test-bomb.tsx", bomb);
  if (tsHits.length === 0) return false;
  let bunCaught = false;
  try {
    new Bun.Transpiler({ loader: "tsx" }).transformSync(bomb);
  } catch {
    bunCaught = true;
  }
  if (!bunCaught) return false;
  // Control: valid code must produce ZERO diagnostics (no false positives).
  const clean = `const candidates = ["a", "b"];\nexport function pick(i: number): string {\n  return candidates[i % candidates.length];\n}\n`;
  return tsParseCheck("self-test-clean.tsx", clean).length === 0;
}

// ---------------------------------------------------------------------------
const all: string[] = [];
for (const root of ROOTS) collectFiles(join(process.cwd(), root), all);
all.sort();

if (!selfTest()) {
  console.error("SYNTAX SWEEP SELF-TEST FAILED: the checker cannot detect the r199 bomb shape (or false-positives on clean code). Sweep is blind — refusing to pass.");
  process.exit(1);
}
console.log(`self-test: bomb detected by ts parser + bun transpiler, clean code passes — checker is awake`);

for (const file of all) {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    console.error(`READ FAIL ${file}: ${err instanceof Error ? err.message : String(err)}`);
    failures++;
    continue;
  }
  scanned++;
  // Bun transpile opinion only for TS-family files (JS/JSX may use
  // project-specific syntax the bun loader would reject out of context).
  const issues = [
    ...tsParseCheck(file, text),
    ...(EXTS_TS.has(file.slice(file.lastIndexOf("."))) ? bunParseCheck(file, text) : []),
  ];
  for (const issue of issues) {
    failures++;
    const where = issue.line > 0 ? `${issue.file}:${issue.line}:${issue.col}` : issue.file;
    console.error(`PARSE FAIL ${where}\n  ${issue.message}\n  > ${issue.sourceLine}`);
  }
}

const rel = (p: string) => relative(process.cwd(), p).split(sep).join("/");
console.log(`\nSYNTAX SWEEP: ${scanned} files fresh-parsed (ts compiler API + bun transpiler), ${failures} failure(s)`);
console.log(failures === 0 ? "PASS — every file on disk parses from scratch; no cache is hiding a broken file" : "FAIL — see PARSE FAIL lines above");
if (process.env.SWEEP_VERBOSE === "1") {
  console.log(`files: ${all.map(rel).join("\n  ")}`);
}
process.exit(failures === 0 ? 0 : 1);
