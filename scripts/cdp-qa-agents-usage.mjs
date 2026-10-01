#!/usr/bin/env node
// ─── r162 QA: honest agent usage (V-series) ─────────────────────────────────
// The roster's usage chip counted only chat replies — pipeline workhorses
// read as idle. The chip now merges completed pipeline steps (status="done"
// only) from the workflows store. Live checks, seeded localStorage:
//   V1  agent with 2 done steps + 1 error step → chip "2 steps" (error step
//       must NOT count — honest completed work), no "repl" text.
//   V2  adding one chat reply (seeded conversation) → chip "1 reply · 2 steps"
//       (merged, not two chips).
//   V3  an agent with zero usage → NO chip (silence stays truthful).
// Usage: node scripts/cdp-qa-agents-usage.mjs [baseUrl]

import { chromium } from "playwright";

const BASE = process.argv[2] ?? "http://localhost:3000";

let passed = 0;
let failed = 0;
function check(name, ok, detail = "") {
  if (ok) passed += 1;
  else failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const NOW = Date.now();
const HOUR = 3_600_000;

const AGENTS = [
  { id: "agent_a", name: "Scout Prime", emoji: "🔍", color: "violet", role: "researcher", description: "", instructions: "", model: "auto", temperature: 0.7, maxIterations: 3, tools: [], createdAt: NOW, updatedAt: NOW },
  { id: "agent_b", name: "Essay Hand", emoji: "✍️", color: "emerald", role: "writer", description: "", instructions: "", model: "auto", temperature: 0.7, maxIterations: 3, tools: [], createdAt: NOW, updatedAt: NOW },
  { id: "agent_c", name: "Idle Intern", emoji: "💤", color: "amber", role: "unused", description: "", instructions: "", model: "auto", temperature: 0.7, maxIterations: 3, tools: [], createdAt: NOW, updatedAt: NOW },
];

const step = (id, agentId, agentName, status, minsAgo) => ({
  stepId: `st_${id}`,
  agentId,
  agentName,
  agentEmoji: "🔍",
  label: `step ${id}`,
  output: "ok",
  toolCalls: [],
  status,
});
const run = (id, steps, minsAgo) => ({
  id: `run_${id}`,
  workflowId: "wf_usage",
  workflowName: "Usage Probe",
  task: "probe",
  status: "done",
  startedAt: NOW - minsAgo * 60_000,
  finishedAt: NOW - minsAgo * 60_000 + 30_000,
  steps,
});

const WORKFLOWS = [
  {
    id: "wf_usage",
    name: "Usage Probe",
    description: "",
    task: "probe",
    steps: [],
    runs: [
      run("r1", [step("s1", "agent_a", "Scout Prime", "done", 5), step("s2", "agent_a", "Scout Prime", "error", 6), step("s3", "agent_b", "Essay Hand", "done", 7)], 5),
      run("r2", [step("s4", "agent_a", "Scout Prime", "done", 90)], 90),
    ],
    createdAt: NOW - 2 * 24 * HOUR,
    updatedAt: NOW - 5 * 60_000,
  },
];

const CONVERSATIONS = [
  {
    id: "conv_usage",
    title: "Usage probe chat",
    messages: [
      { id: "m1", role: "user", content: "hi", createdAt: NOW - HOUR },
      { id: "m2", role: "assistant", content: "hello", agentId: "agent_a", createdAt: NOW - HOUR + 5_000 },
    ],
    createdAt: NOW - HOUR,
    updatedAt: NOW - HOUR,
  },
];

async function gotoAgents(page) {
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  const nav = page.getByRole("button", { name: /^Agents/ }).first();
  await nav.waitFor({ timeout: 20000 });
  // full pointer sequence (r160 lesson)
  await nav.dispatchEvent("pointerdown", { button: 0 });
  await nav.dispatchEvent("pointerup", { button: 0 });
  await nav.click();
  await page.locator("text=Agent Roster").first().waitFor({ timeout: 20000 });
}

async function chipText(page, agentName) {
  const card = page.locator('[role="button"]', { hasText: agentName }).first();
  const chip = card.locator("div", { hasText: /step|repl/ }).last();
  return (await chip.textContent().catch(() => "")) ?? "";
}

async function main() {
  const browser = await chromium.launch({
    executablePath:
      "/home/z/.cache/ms-playwright/chromium_headless_shell-1200/chrome-headless-shell-linux64/chrome-headless-shell",
    args: ["--no-sandbox"],
  });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    // Seed BEFORE first load (reads are plain localStorage; writes are debounced).
    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" }).catch(() => {});
    await page.evaluate(([agents, workflows]) => {
      localStorage.setItem("praison-agents", JSON.stringify({ state: { agents }, version: 1 }));
      localStorage.setItem("praison-workflows", JSON.stringify({ state: { workflows, proposals: [] }, version: 0 }));
    }, [AGENTS, WORKFLOWS]);

    // V1: steps chip, error step excluded, no replies text
    await gotoAgents(page);
    const a = await chipText(page, "Scout Prime");
    check("V1a Scout Prime shows 2 steps (error step excluded)", /2\s*step/.test(a) && !/3\s*step/.test(a), a.trim());
    check("V1b no replies segment yet", !/repl/.test(a), a.trim());

    // V2: merge a chat reply into the same chip
    await page.evaluate((conversations) => {
      localStorage.setItem("praison-conversations", JSON.stringify({ state: { conversations }, version: 0 }));
    }, CONVERSATIONS);
    await page.reload({ waitUntil: "domcontentloaded" });
    await gotoAgents(page);
    const a2 = await chipText(page, "Scout Prime");
    check("V2 reply + steps merged in one chip", /1\s*repl/.test(a2) && /2\s*step/.test(a2), a2.trim());
    const b2 = await chipText(page, "Essay Hand");
    check("V2b Essay Hand shows 1 step", /1\s*step/.test(b2) && !/repl/.test(b2), b2.trim());

    // V3: zero-usage agent renders NO chip
    const c = await chipText(page, "Idle Intern");
    check("V3 zero-usage agent has no chip", !/step|repl/.test(c), c.trim() || "(no chip)");

    await page.screenshot({ path: "ops/qa/V-agents-usage.png" });
  } finally {
    // Clean the synthetic seeds so the user's real data is untouched state-wise
    // (their own browser profile holds the real store; this is the QA profile).
    await browser.close().catch(() => {});
  }

  console.log(`\nV-series: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error("HARNESS ERROR:", e);
  process.exit(1);
});
