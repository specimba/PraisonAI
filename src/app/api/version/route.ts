import { NextResponse } from "next/server";
import * as fs from "node:fs";
import * as path from "node:path";

// r189 — code-freshness stamp for the stale-tab guard. In-tab schedules run
// the bundle the tab LOADED, not the bundle the server is now serving: dev
// HMR dies silently in throttled background tabs, so scheduler/relay fixes
// keep "not working" for hours while the code is actually fixed (r185/r186
// repeat). The client polls this endpoint; a changed stamp = "refresh me".
//
// Stamp = boot id : newest mtime under src/. Any edit under src/ (which is
// exactly what the client bundle is built from) moves the stamp — with no
// rebuild and no config. In a prod deploy the same shape still works: a new
// deploy has new mtimes and a new boot.

export const dynamic = "force-dynamic";

const BOOT_ID = Math.random().toString(36).slice(2, 8);
let cached: { stamp: string; at: number } | null = null;

function newestMtime(dir: string, newest = 0): number {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return newest;
  }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      newest = newestMtime(p, newest);
    } else {
      try {
        newest = Math.max(newest, fs.statSync(p).mtimeMs);
      } catch {
        /* raced a delete — ignore */
      }
    }
  }
  return newest;
}

export async function GET() {
  if (!cached || Date.now() - cached.at > 5_000) {
    cached = {
      stamp: `${BOOT_ID}:${Math.round(newestMtime(path.join(process.cwd(), "src")))}`,
      at: Date.now(),
    };
  }
  return NextResponse.json({ stamp: cached.stamp });
}
