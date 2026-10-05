import { ensureChrome } from "./cdp-ensure-chrome.mjs";
// O-series — workflow editor save-truth (r232).
// Proves the workflow editor dialog never lies on save:
//   O1  empty name + save → INLINE error at the name field (aria-invalid +
//       role=alert), dialog stays open, focus pulled to the input (r225 contract)
//   O2  named but one step unassigned → save BLOCKED: inline alert names the
//       count ("1 step has no agent"), SelectTrigger aria-invalid=true, focus
//       on the offending trigger (pre-fix: the labeled step was SILENTLY dropped)
//   O3   picking an agent clears the error immediately (alert gone, aria-invalid gone)
//   O4  valid save → "Workflow created" toast, dialog closes, store holds the
//       workflow with EXACTLY the authored step (label survived, nothing dropped)
//   O5  hygiene: praison-workflows snapshot restored — zero qa-r232 residue
// Doctrine: never assume the view (sidebar Workflows + explicit Pipelines tab —
// the Runs board sub-view starves card clicks); Radix SelectTrigger opens on
// POINTERDOWN (full sequence at element center); boot chrome + run in ONE shell
// command; failure screenshots are automatic via captureFailure.
// Usage: node scripts/cdp-qa-editor-save-truth.mjs [baseUrl]
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
    expression,
    returnByValue: true,
    awaitPromise: false,
  });
  if (r.exceptionDetails) {
    throw new Error(`evaluate failed: ${r.exceptionDetails.text}`);
  }
  return r.result.value;
}

async function waitFor(ws, expr, timeoutMs = 15_000, everyMs = 400) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evalJs(ws, `Boolean(${expr})`)) return true;
    await new Promise((r) => setTimeout(r, everyMs));
  }
  return false;
}

// r230 improvement pattern: every FAILED check auto-captures the page.
let activeWs = null;
let failSeq = 0;
function captureFailure(name) {
  if (!activeWs) return;
  const file = path.join(
    OUT_DIR,
    `FAIL-${String(++failSeq).padStart(2, "0")}-${name.split(/\s+/)[0]}.png`,
  );
  wsSend(activeWs, "Page.captureScreenshot", { format: "png" })
    .then((r) => {
      fs.writeFileSync(file, Buffer.from(r.data, "base64"));
      console.log(`  📸 ${file}`);
    })
    .catch(() => console.log(`  (failure screenshot unavailable for ${name})`));
}

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) captureFailure(name);
}

const WF_NAME = "qa-r232 save-truth pipeline";
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
// Radix opens on POINTERDOWN — dispatch the full sequence at the element center.
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
const SET_VALUE = (selector, value) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return false;
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype, "value").set;
  setter.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
})()`;
const bodyHas = (s) => `document.body.innerText.includes(${JSON.stringify(s)})`;

async function main() {
  await ensureChrome();
  const list = await (await fetch("http://127.0.0.1:9222/json/list")).json();
  let tab = list.find((t) => t.type === "page" && (t.url || "").startsWith("http://localhost:3000"));
  if (!tab) tab = list.find((t) => t.type === "page");
  const ws = await connect(tab.webSocketDebuggerUrl);
  activeWs = ws;
  await wsSend(ws, "Page.enable");
  try {
    // ── Land on the app, strip any qa-r232 leftovers, snapshot the store. ──
    await wsSend(ws, "Page.navigate", { url: BASE });
    await waitFor(ws, `document.readyState === "complete"`);
    await new Promise((r) => setTimeout(r, 2000));
    await evalJs(ws, `(() => {
      const raw = localStorage.getItem("praison-workflows");
      if (!raw) return true;
      try {
        const envelope = JSON.parse(raw);
        if (envelope?.state?.workflows) {
          envelope.state.workflows = envelope.state.workflows.filter(
            (w) => !(w.name || "").includes("qa-r232"));
          localStorage.setItem("praison-workflows", JSON.stringify(envelope));
        }
      } catch {}
      return true;
    })()`);
    const snapshot = await evalJs(ws, `localStorage.getItem("praison-workflows")`);

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
      check("O0 dialog opened", false);
      return;
    }

    // ── O1: empty name + save → inline error at the field. ───────────────
    await evalJs(ws, POINTER_SEQ(
      `[...document.querySelectorAll('[role="dialog"] button')].find(
        (b) => /^(Create workflow|Save changes)$/.test((b.textContent || "").trim()))`));
    await new Promise((r) => setTimeout(r, 600));
    const o1 = await evalJs(ws, `(() => {
      const input = document.getElementById("wf-name");
      const err = document.getElementById("wf-name-error");
      return {
        invalid: input?.getAttribute("aria-invalid") === "true",
        alert: err?.getAttribute("role") === "alert" && (err.textContent || "").includes("Give your workflow a name"),
        focused: document.activeElement === input,
        dialogOpen: Boolean(document.querySelector('[role="dialog"]')),
      };
    })()`);
    check("O1 empty-name save → inline error at the field", o1.invalid && o1.alert && o1.focused && o1.dialogOpen,
      `invalid=${o1.invalid} alert=${o1.alert} focused=${o1.focused} dialogOpen=${o1.dialogOpen}`);

    // ── Name the workflow, add a labeled-but-unassigned step. ────────────
    await evalJs(ws, SET_VALUE("#wf-name", WF_NAME));
    await evalJs(ws, POINTER_SEQ(
      `[...document.querySelectorAll('[role="dialog"] button')].find(
        (b) => (b.textContent || "").trim() === "Add step")`));
    await new Promise((r) => setTimeout(r, 500));
    await evalJs(ws, SET_VALUE('[aria-label="Label for step 1"]', "qa-r232 labeled step"));
    await new Promise((r) => setTimeout(r, 300));

    // ── O2: save with the step unassigned → BLOCKED + inline alert. ──────
    await evalJs(ws, POINTER_SEQ(
      `[...document.querySelectorAll('[role="dialog"] button')].find(
        (b) => /^(Create workflow|Save changes)$/.test((b.textContent || "").trim()))`));
    await new Promise((r) => setTimeout(r, 600));
    const o2 = await evalJs(ws, `(() => {
      const alertEl = document.getElementById("wf-steps-error");
      const trigger = document.querySelector('[role="dialog"] [aria-label="Agent for step 1"]');
      return {
        alert: alertEl?.getAttribute("role") === "alert" && (alertEl.textContent || "").includes("1 step has no agent"),
        invalid: trigger?.getAttribute("aria-invalid") === "true",
        describedby: trigger?.getAttribute("aria-describedby") === "wf-steps-error",
        focused: document.activeElement === trigger,
        dialogOpen: Boolean(document.querySelector('[role="dialog"]')),
      };
    })()`);
    check("O2 unassigned-step save → blocked with inline alert + aria-invalid + focus",
      o2.alert && o2.invalid && o2.describedby && o2.focused && o2.dialogOpen,
      `alert=${o2.alert} invalid=${o2.invalid} describedby=${o2.describedby} focused=${o2.focused}`);

    // ── O3: pick an agent → error clears immediately. ────────────────────
    await evalJs(ws, POINTER_SEQ(
      `document.querySelector('[role="dialog"] [aria-label="Agent for step 1"]')`));
    if (!(await waitFor(ws, `Boolean(document.querySelector('[role="listbox"] [role="option"]'))`, 10_000))) {
      console.log("FATAL: Select options never opened");
      return;
    }
    await evalJs(ws, POINTER_SEQ(
      `document.querySelector('[role="listbox"] [role="option"]')`));
    await new Promise((r) => setTimeout(r, 600));
    const o3 = await evalJs(ws, `(() => {
      const trigger = document.querySelector('[role="dialog"] [aria-label="Agent for step 1"]');
      return {
        alertGone: !document.getElementById("wf-steps-error"),
        invalidCleared: trigger?.getAttribute("aria-invalid") !== "true",
        assigned: (trigger?.textContent || "").trim().length > 0 && !(trigger?.textContent || "").includes("Select agent"),
      };
    })()`);
    check("O3 picking an agent clears the error immediately",
      o3.alertGone && o3.invalidCleared && o3.assigned,
      `alertGone=${o3.alertGone} invalidCleared=${o3.invalidCleared} assigned=${o3.assigned}`);

    // ── O4: valid save → toast, dialog closes, store holds the step. ─────
    await evalJs(ws, POINTER_SEQ(
      `[...document.querySelectorAll('[role="dialog"] button')].find(
        (b) => /^(Create workflow|Save changes)$/.test((b.textContent || "").trim()))`));
    const toastShown = await waitFor(ws, bodyHas("Workflow created"), 10_000);
    await waitFor(ws, `!Boolean(document.querySelector('[role="dialog"]'))`, 10_000);
    // r232 debug: persist may flush late — sample twice, and dump all names.
    await new Promise((r) => setTimeout(r, 1200));
    const o4 = await evalJs(ws, `(() => {
      const s = JSON.parse(localStorage.getItem("praison-workflows") || "null");
      const wfs = s?.state?.workflows ?? [];
      const wf = wfs.find((w) => (w.name || "") === ${JSON.stringify(WF_NAME)});
      return {
        saved: Boolean(wf),
        stepCount: wf?.steps?.length ?? 0,
        labelSurvived: (wf?.steps?.[0]?.label || "") === "qa-r232 labeled step",
        agentAssigned: Boolean(wf?.steps?.[0]?.agentId),
        allNames: wfs.map((w) => w.name).slice(0, 12),
        envelopeKeys: s ? Object.keys(s) : [],
      };
    })()`);
    console.log("  (O4 debug)", JSON.stringify(o4));
    check("O4 valid save → toast + dialog closes + authored step intact (nothing dropped)",
      toastShown && o4.saved && o4.stepCount === 1 && o4.labelSurvived && o4.agentAssigned,
      `toast=${toastShown} saved=${o4.saved} stepCount=${o4.stepCount} labelSurvived=${o4.labelSurvived} agentAssigned=${o4.agentAssigned}`);

    // ── O5: restore snapshot; zero qa-r232 residue. ──────────────────────
    // r260: both restore writes happen from a bare same-origin JSON page
    // (gotoBare) — a live app page's in-memory persist can race a foreign
    // write and resurrect qa-r* rows across the navigate/reload (J5 race,
    // root-caused r259 on search-match-truth). Residue is then read on the
    // bare page: same-origin localStorage, zero app JS to race the read.
    const gotoBare = async (ws) => {
      await evalJs(ws, `window.__r260bare = 1`);
      await evalJs(ws, `location.href = "/api/providers/free-models"`);
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 100));
        try {
          if (String(await evalJs(ws, `window.__r260bare`)) !== "1") {
            if ((await evalJs(ws, `document.readyState`)) === "complete") return true;
          }
        } catch { /* execution context detached mid-navigation */ }
      }
      return false;
    };
    await gotoBare(ws);
    await evalJs(
      ws,
      snapshot == null
        ? `localStorage.removeItem("praison-workflows"); true`
        : `localStorage.setItem("praison-workflows", ${JSON.stringify(snapshot)}); true`);
    await wsSend(ws, "Page.navigate", { url: BASE });
    await waitFor(ws, `document.readyState === "complete"`);
    await new Promise((r) => setTimeout(r, 1500));
    await gotoBare(ws);
    await evalJs(
      ws,
      snapshot == null
        ? `localStorage.removeItem("praison-workflows"); true`
        : `localStorage.setItem("praison-workflows", ${JSON.stringify(snapshot)}); true`);
    await wsSend(ws, "Page.reload");
    await waitFor(ws, `document.readyState === "complete"`);
    await new Promise((r) => setTimeout(r, 1500));
    const residue = await evalJs(ws, `(() => {
      const s = JSON.parse(localStorage.getItem("praison-workflows") || "null");
      return (s?.state?.workflows ?? []).filter((w) => (w.name || "").includes("qa-r232")).length;
    })()`);
    check("O5 workflows store restored — zero qa-r232 residue", residue === 0, `residue=${residue}`);
  } finally {
    try { await wsSend(ws, "Page.close"); } catch {}
  }

  const pass = results.filter((r) => r.ok).length;
  const fail = results.length - pass;
  console.log(`\nSUMMARY: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
