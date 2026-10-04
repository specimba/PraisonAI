import { ensureChrome } from "./cdp-ensure-chrome.mjs";
// r231 probe — dump every praison* localStorage key with its qa-r228 reference
// count, to find where the N-suite's seeded schedule survives the restore.
// Usage: node scripts/cdp-probe-keys.mjs
import { setTimeout as sleep } from "node:timers/promises";

await ensureChrome();
const BASE = "http://127.0.0.1:9222";
const list = await (await fetch(`${BASE}/json/list`)).json();
const tab = list.find((t) => t.type === "page" && (t.url || "").startsWith("http://localhost:3000"));
if (!tab) { console.error("FATAL: no app tab — open http://localhost:3000 first"); process.exit(2); }

const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
let id = 0;
const rpc = (method, params) =>
  new Promise((resolve, reject) => {
    const i = ++id;
    pending.set(i, (m) => (m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result)));
    ws.send(JSON.stringify({ id: i, method, params }));
    setTimeout(() => { if (pending.has(i)) { pending.delete(i); reject(new Error("timeout " + method)); } }, 15000);
  });

const r = await rpc("Runtime.evaluate", {
  expression: `JSON.stringify(
    Object.keys(localStorage)
      .filter((k) => k.startsWith("praison"))
      .map((k) => ({ key: k, hits: (localStorage.getItem(k).match(/qa-r228/g) || []).length, bytes: localStorage.getItem(k).length }))
  )`,
  returnByValue: true,
});
console.log("KEYS:", r.result.value);
ws.close();
process.exit(0);
