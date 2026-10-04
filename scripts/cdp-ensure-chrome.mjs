// ─── CDP self-heal (r254) ────────────────────────────────────────────────────
// The sandbox reaps agent-spawned processes between rounds, chrome-headless-
// shell included. Every cdp-qa suite used to assume a live 9222 and died with
// a bare "TypeError: fetch failed" when it wasn't (seen for real in r252's
// esc-stop run — cost three diagnosis rounds). This helper makes the suite
// fleet self-heal: probe 9222, and if it's dead, relaunch the playwright
// chrome-headless-shell with the standard QA profile before the suite dials it.
// Idempotent and cheap when chrome is already up (one 1.5s-timeout probe).
//
// Usage (top of a suite's async main, before its first 127.0.0.1:9222 call):
//   import { ensureChrome } from "./cdp-ensure-chrome.mjs";
//   await ensureChrome(); // throws with a CLEAR message if it can't recover

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const CDP = "http://127.0.0.1:9222";
const PROFILE = "/tmp/cdp-qa-profile";

async function cdpAlive() {
  try {
    const r = await fetch(`${CDP}/json/version`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

function findChromeBin() {
  const root = path.join(os.homedir(), ".cache", "ms-playwright");
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  const dirs = entries
    .filter((d) => d.isDirectory() && d.name.startsWith("chromium_headless_shell"))
    .map((d) => d.name)
    .sort();
  for (const dir of dirs) {
    const bin = path.join(root, dir, "chrome-headless-shell-linux64", "chrome-headless-shell");
    if (fs.existsSync(bin)) return bin;
  }
  return null;
}

/**
 * Guarantee chrome-headless-shell answers on 127.0.0.1:9222.
 * Returns "up" if it was already alive, "relaunched" if we revived it.
 * Throws an explicit error (never a bare "fetch failed") if recovery fails.
 */
export async function ensureChrome() {
  if (await cdpAlive()) return "up";

  // A wedged shell can hold the port half-open — clear it first.
  try {
    spawn("pkill", ["-f", "chrome-headless-shell"], { stdio: "ignore" }).unref();
  } catch {
    /* pkill missing — best effort */
  }
  await new Promise((r) => setTimeout(r, 800));

  const bin = findChromeBin();
  if (!bin) {
    throw new Error(
      "ensureChrome: no chrome-headless-shell binary under ~/.cache/ms-playwright — run the playwright install once"
    );
  }
  const child = spawn(
    bin,
    [
      "--headless",
      "--remote-debugging-port=9222",
      `--user-data-dir=${PROFILE}`,
      "--no-sandbox",
      "--disable-gpu",
      "about:blank",
    ],
    { stdio: "ignore", detached: true }
  );
  child.unref();

  for (let i = 0; i < 20; i++) {
    if (await cdpAlive()) return "relaunched";
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("ensureChrome: chrome did not answer on 9222 within 10s of relaunch");
}
