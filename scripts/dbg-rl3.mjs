import { chromium } from "playwright";
const MIN = 60_000;
const browser = await chromium.launch({
  executablePath:
    "/home/z/.cache/ms-playwright/chromium_headless_shell-1200/chrome-headless-shell-linux64/chrome-headless-shell",
  args: ["--no-sandbox"],
});
const context = await browser.newContext();
const page = await context.newPage();
const seed = {
  state: {
    workflows: [
      {
        id: "rl-backoff",
        name: "Backoff Wf",
        description: "r171 fixture rl-backoff",
        steps: [],
        runs: [],
        createdAt: 1,
        updatedAt: 1,
        schedule: {
          enabled: false,
          intervalMs: 60 * MIN,
          task: "t",
          failStreak: 2,
          autoResumeTrips: 1,
          autoResumeAt: Date.now() - 1000,
        },
      },
    ],
  },
  version: 0,
};
await context.addInitScript(
  (s) => localStorage.setItem("praison-workflows", JSON.stringify(s)),
  seed
);
await page.goto("http://localhost:3000/", { waitUntil: "domcontentloaded" });
// wait for the auto-resume toast, then poll the persisted schedule every 500ms
await page.waitForFunction(
  () =>
    [...document.querySelectorAll("[data-sonner-toast]")].some((t) =>
      (t.textContent ?? "").includes("Gateway backoff elapsed")
    ),
  { timeout: 25_000 }
);
console.log("toast visible — polling persisted state:");
for (let i = 0; i < 24; i++) {
  const st = await page.evaluate(() => {
    const w = JSON.parse(localStorage.getItem("praison-workflows") ?? "{}").state?.workflows?.[0];
    return w?.schedule
      ? { en: w.schedule.enabled, ar: w.schedule.autoResumeAt ?? null, nr: w.schedule.nextRunAt ?? null, fs: w.schedule.failStreak }
      : "missing";
  });
  console.log(`t+${(i * 0.5).toFixed(1)}s`, JSON.stringify(st));
  if (typeof st === "object" && st.en === true) {
    console.log("PERSISTED FLUSH CONFIRMED");
    break;
  }
  await page.waitForTimeout(500);
}
await browser.close();
