import { chromium } from "playwright";
const browser = await chromium.launch({
  executablePath: "/home/z/.cache/ms-playwright/chromium_headless_shell-1200/chrome-headless-shell-linux64/chrome-headless-shell",
  args: ["--no-sandbox"],
});
const page = await (await browser.newContext()).newPage();
page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 300)));
const MIN = 60_000;
function wf(id, name, schedule, steps) {
  return { id, name, description: `fixture ${id}`, steps, runs: [], createdAt: 1, updatedAt: 1, ...(schedule ? { schedule } : {}) };
}
const oneStep = [{ id: "s1", agentId: "a1", label: "Only step" }];
const seed = { state: { workflows: [
  wf("rl-backoff", "Backoff Wf", { enabled: false, intervalMs: 60 * MIN, task: "t", failStreak: 2, autoResumeTrips: 1, autoResumeAt: Date.now() - 1000 }),
  wf("rl-future", "Future Wf", { enabled: false, intervalMs: 60 * MIN, task: "t", failStreak: 2, autoResumeTrips: 1, autoResumeAt: Date.now() + 60 * MIN }),
  wf("rl-manual", "Manual Wf", { enabled: false, intervalMs: 60 * MIN, task: "t", failStreak: 3 }, oneStep),
] }, version: 0 };
await page.addInitScript((s) => {
  if (sessionStorage.getItem("__dbg") === "1") return;
  sessionStorage.setItem("__dbg", "1");
  localStorage.clear();
  localStorage.setItem("praison-workflows", JSON.stringify(s));
}, seed);
await page.goto("http://localhost:3000/", { waitUntil: "domcontentloaded" });
for (let s = 1; s <= 10; s++) {
  await page.waitForTimeout(1000);
  const raw = await page.evaluate(() => {
    const v = JSON.parse(localStorage.getItem("praison-workflows") ?? "{}");
    const b = v?.state?.workflows?.find((w) => w.id === "rl-backoff")?.schedule;
    return { en: b?.enabled, n: v?.state?.workflows?.length,
      toasts: [...document.querySelectorAll("[data-sonner-toast]")].map((t) => (t.textContent ?? "").slice(0, 50)) };
  });
  console.log(`t=${s}s`, JSON.stringify(raw));
  if (raw.en === true) { console.log("FLIPPED"); break; }
}
await browser.close();
