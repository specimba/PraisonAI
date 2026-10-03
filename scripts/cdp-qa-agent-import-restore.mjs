// ─── CDP QA — L-series (r226): agent import is a truthful restore path ───────
// The r226 change: sanitizeAgent always minted a FRESH id on import, so
// export → wipe → import could never reconnect workflows that referenced the
// original agent ids (the delete dialog literally warns "steps will run
// without an agent until updated" — and the restore path guaranteed it).
// Now a well-formed, non-colliding id is preserved (workflow wiring survives
// a wipe+restore); re-importing onto an existing roster still mints fresh
// copies (every id collides — nothing clobbered). Also: flags no longer get
// cut in half (.slice(0,2) → shared firstGrapheme).
// Asserts end-to-end against the live dev server:
//   L1  importing a 2-agent PraisonAI export via the real file input →
//       "Imported 2 agents" toast, and the roster holds the file's EXACT ids
//   L2  flag emoji 🇺🇸 survives round-trip in the store (pre-fix: sliced in
//       half) — the mechanism workflows need (same id) plus the emoji truth
//   L3  re-importing the SAME file → 4 agents: originals keep their ids,
//       copies get fresh ones, no clobbering
//   L4  hygiene: praison-agents snapshot restored — zero qa-r226 residue
// File-import doctrine (r223): DataTransfer + new File → input.files →
// synthetic change event (no CDP upload domain needed).
// r223/r224 lessons: boot chrome + run in ONE shell command; never assume
// the chat view is showing (ui store persists the last view). Launch
// chrome-headless-shell on :9222 first.
// Usage: node scripts/cdp-qa-agent-import-restore.mjs [baseUrl]
import fs from "node:fs";
import path from "node:path";

const BASE = process.argv[2] ?? "http://localhost:3000";
const OUT_DIR = path.resolve("ops/qa");
fs.mkdirSync(OUT_DIR, { recursive: true });

let msgId = 0;
const pending = new Map();

function wsSend(ws, method, params = {}) {
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }
    }, 60_000);
  });
}

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error("ws error"));
  });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    }
  };
  return ws;
}

async function evalJs(ws, expression) {
  const r = await wsSend(ws, "Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description ?? "eval error");
  }
  return r.result?.value;
}

async function waitFor(ws, expr, timeoutMs = 30_000, everyMs = 400) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await evalJs(ws, `Boolean(${expr})`)) return true;
    await new Promise((r) => setTimeout(r, everyMs));
  }
  return false;
}

async function shot(ws, name) {
  const r = await wsSend(ws, "Page.captureScreenshot", { format: "png" });
  const file = path.join(OUT_DIR, `${name}.png`);
  fs.writeFileSync(file, Buffer.from(r.data, "base64"));
  console.log(`  📸 ${file}`);
}

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
}

const EXPORT = {
  kind: "praison-agents",
  version: 1,
  exportedAt: new Date().toISOString(),
  agents: [
    {
      id: "agent_qa226a",
      name: "qa-r226 alpha",
      emoji: "🇺🇸",
      color: "emerald",
      role: "Restore scout",
      description: "carries a well-formed id",
      instructions: "You are the alpha.",
      model: "auto",
      temperature: 0.4,
      maxIterations: 6,
      tools: ["web_search"],
    },
    {
      id: "agent_qa226b",
      name: "qa-r226 beta",
      emoji: "🤖",
      color: "rose",
      role: "Restore mule",
      description: "second of two",
      instructions: "You are the beta.",
      model: "auto",
      temperature: 0.7,
      maxIterations: 3,
      tools: [],
    },
  ],
};

const AGENTS_NAV = `(() => {
  const el = [...document.querySelectorAll("button,a")].find(
    (e) => /^Agents/.test((e.textContent || "").trim()) && e.offsetParent !== null);
  if (!el) return false;
  el.click();
  return true;
})()`;

async function gotoAgents(ws) {
  await wsSend(ws, "Page.navigate", { url: BASE });
  await evalJs(ws, "document.title");
  await waitFor(ws, `document.readyState === 'complete'`);
  await new Promise((r) => setTimeout(r, 2000));
  // The ui store persists the last view — land on Agents explicitly.
  if (!(await evalJs(ws, `Boolean([...document.querySelectorAll("button")].find(
      (b) => /^New Agent/.test((b.textContent || "").trim()) && b.offsetParent !== null))`))) {
    await evalJs(ws, AGENTS_NAV);
    await waitFor(ws, `Boolean([...document.querySelectorAll("button")].find(
      (b) => /^New Agent/.test((b.textContent || "").trim()) && b.offsetParent !== null))`, 45_000);
  }
}

/** Push a JSON file through the real hidden import input (r223 doctrine). */
async function importFile(ws) {
  return evalJs(ws, `(async () => {
    const input = document.querySelector('input[type="file"][accept*="json"]');
    if (!input) return false;
    const payload = ${JSON.stringify(JSON.stringify(EXPORT))};
    const file = new File([payload], "qa-r226-agents.json", { type: "application/json" });
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 1200));
    return true;
  })()`);
}

const storeAgents = `((() => {
  try {
    return JSON.parse(localStorage.getItem("praison-agents") || "null")?.state?.agents ?? [];
  } catch { return []; }
})())`;

async function main() {
  const tabRes = await fetch(`http://127.0.0.1:9222/json/new`, { method: "PUT" });
  if (!tabRes.ok) throw new Error(`/json/new failed: ${tabRes.status} — is chrome-headless-shell up?`);
  const tab = await tabRes.json();
  const ws = await connect(tab.webSocketDebuggerUrl);
  try {
    await wsSend(ws, "Page.enable");
    await wsSend(ws, "Runtime.enable");
    await wsSend(ws, "Emulation.setDeviceMetricsOverride", {
      width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false,
    });

    // Snapshot the roster before touching anything.
    await gotoAgents(ws);
    const snapshot = await evalJs(ws, `localStorage.getItem("praison-agents")`);

    // L1 — import through the real input: toast + EXACT ids land
    const fed = await importFile(ws);
    if (!fed) throw new Error("import input not found");
    const toastOk = await waitFor(ws,
      `[...document.querySelectorAll('[data-sonner-toast]')].some(
        (t) => /Imported 2 agents/.test(t.textContent || ""))`, 10_000);
    const ids = await evalJs(ws,
      `${storeAgents}.filter((a) => (a.name || "").startsWith("qa-r226")).map((a) => a.id).sort()`);
    check("L1 import via real file input → 'Imported 2 agents' toast", toastOk);
    check("L1 roster holds the file's EXACT ids (restore path works)",
      JSON.stringify(ids) === JSON.stringify(["agent_qa226a", "agent_qa226b"]),
      `ids=${JSON.stringify(ids)}`);

    // L2 — flag emoji survives round-trip (pre-fix: sliced in half)
    const emoji = await evalJs(ws,
      `${storeAgents}.find((a) => a.id === "agent_qa226a")?.emoji ?? ""`);
    check("L2 flag emoji 🇺🇸 survives import intact",
      emoji === "🇺🇸", `emoji=${JSON.stringify(emoji)} len=${[...String(emoji)].length}`);
    await shot(ws, "L2-imported-flag");

    // L3 — re-import the SAME file: originals keep ids, copies are fresh
    await importFile(ws);
    await waitFor(ws,
      `${storeAgents}.filter((a) => (a.name || "").startsWith("qa-r226")).length === 4`, 10_000);
    const state3 = await evalJs(ws, `(() => {
      const mine = ${storeAgents}.filter((a) => (a.name || "").startsWith("qa-r226"));
      const ids = mine.map((a) => a.id);
      return {
        total: mine.length,
        originalsKept: ids.filter((i) => i === "agent_qa226a" || i === "agent_qa226b").length,
        unique: new Set(ids).size,
      };
    })()`);
    check("L3 re-import → 4 qa-r226 agents, originals kept, all ids unique",
      state3.total === 4 && state3.originalsKept === 2 && state3.unique === 4,
      `state=${JSON.stringify(state3)}`);

    // L4 — hygiene: restore the roster, prove zero residue
    await evalJs(ws, snapshot === null
      ? `localStorage.removeItem("praison-agents"); true`
      : `localStorage.setItem("praison-agents", ${JSON.stringify(snapshot)}); true`);
    await gotoAgents(ws);
    const residue = await evalJs(ws,
      `${storeAgents}.filter((a) => (a.name || "").includes("qa-r226")).length`);
    check("L4 roster restored — zero qa-r226 residue", residue === 0, `residue=${residue}`);
  } finally {
    try { ws.close(); } catch {}
    try { await fetch(`http://127.0.0.1:9222/json/close/${tab.id}`); } catch {}
  }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  console.log(`\nSUMMARY: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`FATAL: ${err.message}`);
  process.exit(1);
});
