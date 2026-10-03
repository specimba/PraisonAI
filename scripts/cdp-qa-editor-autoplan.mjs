// P-series — workflow editor auto-plan: cancellable + honest (r235).
// Proves the AI auto-plan path end-to-end in the browser (r232 left it only
// unit-audited), with runAgentChat mocked at the wire seam (window.fetch →
// SSE "done" frame, the relay contract in src/lib/chat-client.ts):
//   P0  editor dialog opened (Pipelines tab, never trust the sub-view)
//   P1  hang mode → planning state shows ("Generating…" + panel Cancel button;
//       two Cancel buttons exist = panel + footer)
//   P2  Cancel click → planning clears immediately, stub saw the AbortError
//       (signal actually plumbed to the fetch — the r235 fix)
//   P3  plan mode with a valid JSON plan → step lands with label + agent
//       mapping, "Generated 1 steps" toast, plan panel closes
//   P4  unparseable plan content → error toast, steps unchanged (no silent
//       half-state)
//   P5  hygiene: dialog closed without saving — praison-workflows store
//       unchanged, zero qa-p235 residue
// Doctrine: boot chrome + run in ONE shell command; pointer sequences for
// Radix; failure screenshots automatic.
// Usage: node scripts/cdp-qa-editor-autoplan.mjs [baseUrl]
import fs from "node:fs";
import path from "node:path";

const BASE = process.argv[2] ?? "http://localhost:3000";
const OUT_DIR = path.resolve("ops/qa");
fs.mkdirSync(OUT_DIR, { recursive: true });

let msgId = 0;
const pending = new Map();
let activeWs = null;
let failSeq = 0;

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
    }, 30_000);
  });
}

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl); // global (Node ≥22), same as the O harness
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    }
  };
  return ws;
}

async function evalJs(ws, expression) {
  const r = await wsSend(ws, "Runtime.evaluate", {
    expression, returnByValue: true, awaitPromise: true,
  });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + " " + JSON.stringify(r.exceptionDetails.exception?.description ?? "").slice(0, 200));
  return r.result?.value;
}

async function waitFor(ws, expr, timeoutMs = 15_000, everyMs = 400) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evalJs(ws, expr)) return true;
    await new Promise((r) => setTimeout(r, everyMs));
  }
  return false;
}

function captureFailure(name) {
  if (!activeWs) return;
  const file = path.join(OUT_DIR, `FAIL-${String(++failSeq).padStart(2, "0")}-${name.split(/\s+/)[0]}.png`);
  wsSend(activeWs, "Page.captureScreenshot", { format: "png" })
    .then((r) => { fs.writeFileSync(file, Buffer.from(r.data, "base64")); console.log(`  📸 ${file}`); })
    .catch(() => console.log(`  (failure screenshot unavailable for ${name})`));
}

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) captureFailure(name);
}

const NAV_TO_WF = `(() => {
  const el = [...document.querySelectorAll("button,a")].find(
    (e) => /^Workflows/.test((e.textContent || "").trim()) && e.offsetParent !== null);
  if (!el) return false;
  el.click();
  return true;
})()`;
const CLICK_PIPELINES_TAB = `(() => {
  const el = [...document.querySelectorAll("button")].find(
    (e) => (e.textContent || "").trim() === "Pipelines" && e.offsetParent !== null);
  if (el) { el.click(); return true; }
  return false;
})()`;
const POINTER_SEQ = (finder) => `(() => {
  const el = ${finder};
  if (!el) return false;
  const r = el.getBoundingClientRect();
  const x = r.left + r.width / 2, y = r.top + r.height / 2;
  const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, isPrimary: true };
  for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
    el.dispatchEvent(type.startsWith("pointer")
      ? new PointerEvent(type, opts)
      : new MouseEvent(type, opts));
  }
  return true;
})()`;
// Works for input AND textarea (r235: the plan task box is a Textarea).
const SET_VALUE = (selector, value) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return false;
  const proto = el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
  setter.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
})()`;
const bodyHas = (s) => `document.body.innerText.includes(${JSON.stringify(s)})`;

const FIND = {
  generate: `[...document.querySelectorAll('[role="dialog"] button')].find(
    (b) => /^(Generate|Generating…)$/.test((b.textContent || "").trim()))`,
  cancelPanel: `[...document.querySelectorAll('[role="dialog"] button')].filter(
    (b) => (b.textContent || "").trim() === "Cancel")[0]`,
  toggle: `[...document.querySelectorAll('[role="dialog"] button')].find(
    (b) => (b.textContent || "").includes("Auto-assign with AI"))`,
  footerCancel: `[...document.querySelectorAll('[role="dialog"] button')].filter(
    (b) => (b.textContent || "").trim() === "Cancel").pop()`,
};

const INSTALL_STUB = `(() => {
  // Installed via Page.addScriptToEvaluateOnNewDocument — the app may capture
  // window.fetch at module-eval time, so the mock MUST exist before hydration.
  if (window.__planStubInstalled) return true;
  window.__planStubInstalled = true;
  window.__origFetch = window.fetch.bind(window);
  window.__chatMode = "";
  window.__planPayload = null;
  window.__aborted = false;
  window.__stubHits = [];
  window.fetch = (input, init) => {
    let url = "";
    try { url = typeof input === "string" ? input : (input && input.url) || String(input); } catch {}
    const mode = window.__chatMode || "";
    const isChat = url.includes("/api/chat");
    const isExternal = /^https?:\\/\\//i.test(url) && !url.includes(location.origin);
    if ((isChat || isExternal) && (mode === "hang" || mode === "plan")) {
      window.__stubHits.push(mode + ":" + url.slice(0, 80));
      if (mode === "hang") {
        return new Promise((resolve, reject) => {
          const sig = init && init.signal;
          const onAbort = () => { window.__aborted = true; reject(new DOMException("Aborted", "AbortError")); };
          if (sig && sig.aborted) { onAbort(); return; }
          if (sig) sig.addEventListener("abort", onAbort, { once: true });
          window.__hangResolve = resolve;
        });
      }
      const plan = window.__planPayload ?? [];
      const content = typeof plan === "string" ? plan : JSON.stringify(plan);
      // Speak BOTH wire dialects: the relay SSE event AND the browser-direct
      // OpenAI-chunk stream + [DONE] sentinel — whichever leg parses it, the
      // content lands (QA profile has a vault provider, so the direct leg runs).
      const frame = "data: " + JSON.stringify({ type: "done", content, toolCalls: [], iterations: 1 }) + "\\n\\n" +
        "data: " + JSON.stringify({ choices: [{ delta: { content } }] }) + "\\n\\n" +
        "data: [DONE]\\n\\n";
      const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(frame)); c.close(); } });
      return Promise.resolve(new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } }));
    }
    return window.__origFetch(input, init);
  };
  return true;
})()`;

async function main() {
  const list = await (await fetch("http://127.0.0.1:9222/json/list")).json();
  let tab = list.find((t) => t.type === "page" && (t.url || "").startsWith("http://localhost:3000"));
  if (!tab) tab = list.find((t) => t.type === "page");
  const ws = await connect(tab.webSocketDebuggerUrl);
  activeWs = ws;
  await wsSend(ws, "Page.enable");
  // Mock BEFORE the app boots — module-scope fetch captures see the stub.
  await wsSend(ws, "Page.addScriptToEvaluateOnNewDocument", { source: INSTALL_STUB });
  try {
    // ── Land on the app; snapshot the workflows store; check an agent exists. ──
    await wsSend(ws, "Page.navigate", { url: BASE });
    await waitFor(ws, `document.readyState === "complete"`);
    await new Promise((r) => setTimeout(r, 2000));
    const snapshot = await evalJs(ws, `localStorage.getItem("praison-workflows")`);
    const agentId = await evalJs(ws, `(() => {
      try {
        const a = JSON.parse(localStorage.getItem("praison-agents") || "null");
        return a?.state?.agents?.[0]?.id ?? null;
      } catch { return null; }
    })()`);
    if (!agentId) {
      console.log("FATAL: no agent in praison-agents — auto-plan mapping is untestable");
      return;
    }

    // ── Workflows view → Pipelines tab → New Workflow dialog. ────────────
    await evalJs(ws, NAV_TO_WF);
    await new Promise((r) => setTimeout(r, 1200));
    await evalJs(ws, CLICK_PIPELINES_TAB);
    await new Promise((r) => setTimeout(r, 800));
    if (!(await waitFor(ws, `[...document.querySelectorAll("button")].some(
        (b) => (b.textContent || "").includes("New Workflow") && b.offsetParent !== null)`, 30_000))) {
      console.log("FATAL: New Workflow button never appeared");
      return;
    }
    await evalJs(ws, POINTER_SEQ(
      `[...document.querySelectorAll("button")].find(
        (b) => (b.textContent || "").includes("New Workflow") && b.offsetParent !== null)`));
    if (!(await waitFor(ws, `Boolean(document.querySelector('[role="dialog"]'))`, 15_000))) {
      check("P0 dialog opened", false);
      return;
    }
    check("P0 dialog opened", true);

    // Reset mock state post-hydration (the boot script already installed it).
    await evalJs(ws, `window.__chatMode = ""; window.__planPayload = null; window.__aborted = false; window.__stubHits = []; true`);

    // ── P1: hang mode → planning state with a panel Cancel button. ───────
    await evalJs(ws, POINTER_SEQ(`(${FIND.toggle})`));
    await new Promise((r) => setTimeout(r, 500));
    await evalJs(ws, SET_VALUE("#wf-plan-task", "Research the state of AI agents and write an outline"));
    await evalJs(ws, `window.__chatMode = "hang"; window.__aborted = false; true`);
    await evalJs(ws, POINTER_SEQ(`(${FIND.generate})`));
    const p1 = await waitFor(ws, `(() => {
      const btns = [...document.querySelectorAll('[role="dialog"] button')];
      const generating = btns.some((b) => (b.textContent || "").trim() === "Generating…");
      const cancels = btns.filter((b) => (b.textContent || "").trim() === "Cancel").length;
      return generating && cancels === 2; // panel Cancel + footer Cancel
    })()`, 10_000);
    check("P1 hang → planning state shows Generating… + panel Cancel button", p1,
      `generating+2 Cancel buttons ${p1 ? "seen" : "NOT seen"}`);

    // ── P2: Cancel → planning clears, the signal reached the fetch. ──────
    await evalJs(ws, POINTER_SEQ(`(${FIND.cancelPanel})`));
    const p2a = await waitFor(ws, `(() => {
      const btns = [...document.querySelectorAll('[role="dialog"] button')];
      return !btns.some((b) => (b.textContent || "").trim() === "Generating…")
        && btns.filter((b) => (b.textContent || "").trim() === "Cancel").length === 1;
    })()`, 5_000);
    const p2b = await evalJs(ws, `window.__aborted === true`);
    check("P2 Cancel → planning clears immediately + AbortError hit the transport",
      p2a && p2b, `planningCleared=${p2a} aborted=${p2b}`);

    // ── P3: valid plan → step lands, toast, panel closes. ────────────────
    await evalJs(ws, `window.__chatMode = "plan";
      window.__planPayload = [{ label: "Research trends", agentId: ${JSON.stringify(agentId)}, instruction: "distill the top trends" }];
      true`);
    await evalJs(ws, POINTER_SEQ(`(${FIND.generate})`));
    const p3toast = await waitFor(ws, bodyHas("Generated 1 steps"), 10_000);
    const p3 = await evalJs(ws, `(() => {
      const dlg = document.querySelector('[role="dialog"]');
      const btns = [...(dlg?.querySelectorAll("button") ?? [])];
      return {
        stepShown: [...(dlg?.querySelectorAll("input") ?? [])].some((i) => i.value === "Research trends"),
        instructionShown: (dlg?.textContent || "").replace(/\s+/g, " ").includes("override · set"),
        panelClosed: !btns.some((b) => /^(Generate|Generating…)$/.test((b.textContent || "").trim()))
          && !document.getElementById("wf-plan-task"),
      };
    })()`);
    check("P3 valid plan → step lands with instruction + toast + panel closes",
      p3toast && p3.stepShown && p3.instructionShown && p3.panelClosed,
      `toast=${p3toast} step=${p3.stepShown} instruction=${p3.instructionShown} panelClosed=${p3.panelClosed} stubHits=${JSON.stringify(await evalJs(ws, "window.__stubHits"))}`);

    // ── P4: unparseable plan → honest error, steps unchanged. ────────────
    await new Promise((r) => setTimeout(r, 1500)); // success path fully settles
    await evalJs(ws, POINTER_SEQ(`(${FIND.toggle})`)); // reopen the panel
    await new Promise((r) => setTimeout(r, 500));
    await evalJs(ws, SET_VALUE("#wf-plan-task", "Try a broken planner response"));
    await evalJs(ws, `window.__planPayload = "this is not json"; true`);
    await evalJs(ws, POINTER_SEQ(`(${FIND.generate})`));
    const p4toast = await waitFor(ws, bodyHas("generate a plan, add steps manually"), 10_000);
    const p4keep = await evalJs(ws, `(() => {
      const dlg = document.querySelector('[role="dialog"]');
      return {
        stepKept: [...(dlg?.querySelectorAll("input") ?? [])].some((i) => i.value === "Research trends"),
        idle: [...(dlg?.querySelectorAll("button") ?? [])].some(
          (b) => (b.textContent || "").trim() === "Generate"),
      };
    })()`);
    check("P4 broken planner response → error toast + steps unchanged",
      p4toast && p4keep.stepKept && p4keep.idle,
      `toast=${p4toast} stepKept=${p4keep.stepKept} idle=${p4keep.idle}`);

    // ── P5: hygiene — close without saving; store untouched, no residue. ─
    await evalJs(ws, POINTER_SEQ(`(${FIND.footerCancel})`));
    await waitFor(ws, `!Boolean(document.querySelector('[role="dialog"]'))`, 10_000);
    await wsSend(ws, "Page.navigate", { url: BASE });
    await waitFor(ws, `document.readyState === "complete"`);
    await new Promise((r) => setTimeout(r, 1500));
    const p5 = await evalJs(ws, `(() => {
      const s = JSON.parse(localStorage.getItem("praison-workflows") || "null");
      const wfs = s?.state?.workflows ?? [];
      return {
        storeSame: JSON.stringify(wfs.map((w) => w.name)) === JSON.stringify(
          (JSON.parse(${JSON.stringify(snapshot)} || "null")?.state?.workflows ?? []).map((w) => w.name)),
        residue: wfs.filter((w) => (w.name || "").includes("qa-p235")).length,
      };
    })()`);
    check("P5 hygiene: store unchanged (never saved) + zero qa-p235 residue",
      p5.storeSame && p5.residue === 0,
      `storeSame=${p5.storeSame} residue=${p5.residue}`);
  } finally {
    try { await wsSend(ws, "Page.close"); } catch {}
  }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  console.log(`\nSUMMARY: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
