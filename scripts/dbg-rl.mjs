import { chromium } from "playwright";
const browser = await chromium.launch({
  executablePath: "/home/z/.cache/ms-playwright/chromium_headless_shell-1200/chrome-headless-shell-linux64/chrome-headless-shell",
  args: ["--no-sandbox"],
});
const page = await (await browser.newContext()).newPage();
const MIN = 60_000;
await page.goto("http://localhost:3000/", { waitUntil: "domcontentloaded" }).catch(() => {});
await page.evaluate(() => {
  localStorage.setItem("praison-workflows", JSON.stringify({
    state: { workflows: [{ id: "rl-backoff", name: "Backoff Wf", description: "d", steps: [], runs: [], createdAt: 1, updatedAt: 1,
      schedule: { enabled: false, intervalMs: 3600000, task: "t", failStreak: 2, autoResumeTrips: 1, autoResumeAt: Date.now() - 1000 } }] },
    version: 0,
  }));
});
await page.goto("http://localhost:3000/", { waitUntil: "domcontentloaded" });
for (const ms of [2000, 6000, 13000]) {
  await page.waitForTimeout(ms === 2000 ? 2000 : ms - (ms === 6000 ? 2000 : 6000));
  const raw = await page.evaluate(() => localStorage.getItem("praison-workflows"));
  const wfs = JSON.parse(raw ?? "{}")?.state?.workflows ?? [];
  console.log(`t=${ms}ms: workflows=${wfs.length}`, JSON.stringify(wfs.map(w => ({ id: w.id, sched: w.schedule }))));
}
await browser.close();
