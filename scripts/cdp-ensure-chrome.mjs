// ─── CDP self-heal (r254) ────────────────────────────────────────────────────
// The sandbox reaps agent-spawned processes between rounds, chrome-headless-
// shell included. Every cdp-qa suite used to assume a live 9222 and died with
// a bare "TypeError: fetch failed" when it wasn't (seen for real in r252's
// esc-stop run — cost three diagnosis rounds). This helper makes the suite
// fleet self-heal: probe 9222, and if it's dead, relaunch the playwright
// chrome-headless-shell with the standard QA profile before the suite dials it.
// Idempotent and cheap when chrome is already up (one 1.5s-timeout probe).
//
// r263: liveness is not responsiveness. A shell can answer /json/version
// while its CDP layer is wedged — every WebSocket command (Page.enable,
// Runtime.evaluate) then times out and the suite dies with a bare CDP
// timeout (seen for real in r263's spot-check: vault-guard wedged mid-run,
// digit-shortcuts died at Page.enable despite ensureChrome returning "up").
// ensureChrome now backs the HTTP probe with a one-shot responsiveness
// probe: open a fresh target, evaluate 1+1 over CDP, expect 2. A wedged
// shell fails that and falls through to the same kill+relaunch path a dead
// one would. Single recovery cycle — never a loop.
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

/**
 * True only if the shell actually executes CDP commands. Probes via a FRESH
 * target (an existing one can be the very page that wedged the browser),
 * evaluates 1+1 over WebSocket, and closes the target afterwards. Resolves
 * false on any failure — this probe must never throw or hang a suite.
 */
async function cdpResponsive() {
  let target;
  try {
    let r = await fetch(`${CDP}/json/new?about:blank`, {
      method: "PUT",
      signal: AbortSignal.timeout(1500),
    });
    if (!r.ok) {
      // Older DevTools builds only accept GET for /json/new.
      r = await fetch(`${CDP}/json/new?about:blank`, {
        signal: AbortSignal.timeout(1500),
      });
    }
    if (!r.ok) return false;
    target = await r.json();
  } catch {
    return false;
  }
  const wsURL = target?.webSocketDebuggerUrl;
  if (!wsURL) return false;

  const closeTarget = () => {
    fetch(`${CDP}/json/close/${target.id}`, { signal: AbortSignal.timeout(1500) }).catch(
      () => {}
    );
  };
  return await new Promise((resolve) => {
    const ws = new WebSocket(wsURL);
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* already closing */
      }
      closeTarget();
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), 2500);
    ws.onerror = () => done(false);
    ws.onclose = () => done(false);
    ws.onopen = () => {
      try {
        ws.send(
          JSON.stringify({
            id: 1,
            method: "Runtime.evaluate",
            params: { expression: "1+1", returnByValue: true },
          })
        );
      } catch {
        done(false);
      }
    };
    ws.onmessage = (m) => {
      try {
        const msg = JSON.parse(String(m.data));
        if (msg.id === 1) done(msg.result?.result?.value === 2);
      } catch {
        /* malformed frame — keep waiting for the timer */
      }
    };
  });
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
 * Guarantee chrome-headless-shell ANSWERS on 127.0.0.1:9222 — and actually
 * executes CDP commands, not just serves /json/version.
 * Returns "up" if it was already alive+responsive, "relaunched" if we revived it.
 * Throws an explicit error (never a bare "fetch failed") if recovery fails.
 */
export async function ensureChrome() {
  if ((await cdpAlive()) && (await cdpResponsive())) return "up";
  // Else: dead OR wedged (alive at HTTP level, dead at CDP level) — both fall
  // through to the same single kill+relaunch cycle below.

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
