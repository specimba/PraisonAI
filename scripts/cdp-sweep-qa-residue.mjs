// r229 residue sweeper — removes qa-r2xx-seeded entries from praison-workflows
// (and praison-agents) localStorage after an ABORTED harness run left seeds behind.
// Doctrine context: an aborted suite never reaches its restore step; the NEXT
// run of any suite snapshot-restores faithfully — preserving the foreign seeds
// forever (observed r229: M5 residue=1, N0 seed-card missing). Sweep by prefix.
// Usage: node scripts/cdp-sweep-qa-residue.mjs [prefix ...]  (default qa-r227 qa-r228)
import { setTimeout as sleep } from "node:timers/promises";

const PREFIXES = process.argv.slice(2).length ? process.argv.slice(2) : ["qa-r227", "qa-r228"];
const BASE = "http://127.0.0.1:9222";

async function cdpJson(path) {
  const res = await fetch(`${BASE}${path}`);
  return res.json();
}

const list = await cdpJson("/json/list");
let tab = list.find((t) => t.type === "page" && (t.url || "").startsWith("http://localhost:3000"));
if (!tab) {
  // headless shell 143 ignores /json/new?url= — create blank then navigate
  const created = await cdpJson("/json/new?about:blank");
  tab = created;
  const ws = new WebSocket(created.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  const send = (id, method, params) =>
    ws.send(JSON.stringify({ id, method, params }));
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const rpc = (method, params) =>
    new Promise((resolve) => {
      const id = Date.now() + Math.random();
      pending.set(id, resolve);
      send(id, method, params);
    });
  await rpc("Page.enable");
  await rpc("Page.navigate", { url: "http://localhost:3000/" });
  await sleep(4000);
  ws.close();
  const list2 = await cdpJson("/json/list");
  tab = list2.find((t) => t.type === "page" && (t.url || "").startsWith("http://localhost:3000"));
  if (!tab) { console.error("FATAL: could not establish an app tab"); process.exit(2); }
}

const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
let rpcId = 0;
const rpc = (method, params) =>
  new Promise((resolve, reject) => {
    const id = ++rpcId;
    pending.set(id, (m) =>
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result),
    );
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error("CDP timeout: " + method)); }
    }, 15000);
  });

const expr = `
(() => {
  const prefixes = ${JSON.stringify(PREFIXES)};
  const report = {};
  for (const key of ["praison-workflows", "praison-agents"]) {
    const raw = localStorage.getItem(key);
    if (!raw) { report[key] = { present: false, removed: 0 }; continue; }
    const envelope = JSON.parse(raw);
    const state = envelope.state || {};
    let removed = 0;
    for (const arrKey of Object.keys(state)) {
      if (!Array.isArray(state[arrKey])) continue;
      const before = state[arrKey].length;
      state[arrKey] = state[arrKey].filter((item) => {
        const name = typeof item === "object" && item ? String(item.name ?? "") : "";
        const hit = prefixes.some((p) => name.startsWith(p));
        if (hit) removed++;
        return !hit;
      });
    }
    envelope.state = state;
    localStorage.setItem(key, JSON.stringify(envelope));
    report[key] = { present: true, removed };
  }
  return JSON.stringify(report);
})()
`;

try {
  const result = await rpc("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: false });
  console.log("SWEEP:", result.result.value);
  console.log("SUMMARY: sweep complete for prefixes", PREFIXES.join(","));
} catch (e) {
  console.error("FATAL:", e.message);
  process.exit(1);
} finally {
  ws.close();
}
