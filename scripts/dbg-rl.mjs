import { chromium } from "playwright";
const browser = await chromium.launch({
  executablePath: "/home/z/.cache/ms-playwright/chromium_headless_shell-1200/chrome-headless-shell-linux64/chrome-headless-shell",
  args: ["--no-sandbox"],
});
const page = await (await browser.newContext()).newPage();
page.on("console", (m) => { if (m.type() === "error") console.log(`[console.error]`, m.text().slice(0, 300)); });
page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 400)));
await page.goto("http://localhost:3000/", { waitUntil: "domcontentloaded" }).catch(() => {});
await page.evaluate(() => {
  const wf = (id, schedule) => ({ id, name: id, description: "d", steps: [], runs: [], createdAt: 1, updatedAt: 1, ...(schedule ? { schedule } : {}) });
  localStorage.setItem("praison-workflows", JSON.stringify({ state: { workflows: [
    wf("rl-backoff", { enabled: false, intervalMs: 3600000, task: "t", failStreak: 2, autoResumeTrips: 1, autoResumeAt: Date.now() - 1000 }),
    wf("rl-future", { enabled: false, intervalMs: 3600000, task: "t", failStreak: 2, autoResumeTrips: 1, autoResumeAt: Date.now() + 3600000 }),
    wf("rl-manual", { enabled: false, intervalMs: 3600000, task: "t", failStreak: 3 }),
  ] }, version: 0 }));
});
await page.goto("http://localhost:3000/", { waitUntil: "domcontentloaded" });
for (let s = 1; s <= 12; s++) {
  await page.waitForTimeout(1000);
  const d = await page.evaluate(() => {
    const wfs = JSON.parse(localStorage.getItem("praison-workflows") ?? "{}")?.state?.workflows ?? [];
    const b = wfs.find((w) => w.id === "rl-backoff")?.schedule;
    return {
      n: wfs.length, en: b?.enabled,
      scheds: wfs.map((w) => `${w.id}:${w.schedule ? (w.schedule.enabled ? "on" : "off") + "@" + (w.schedule.nextRunAt ?? "null") : "-"}:steps${w.steps.length}`).join(" | ").slice(0, 300),
      toasts: [...document.querySelectorAll("[data-sonner-toast]")].map((t) => (t.textContent ?? "").slice(0, 70)),
    };
  });
  console.log(`t=${s}s en=${d.en} n=${d.n}`, d.scheds);
  console.log("   toasts:", JSON.stringify(d.toasts));
  if (d.en === true) break;
}
await browser.close();
