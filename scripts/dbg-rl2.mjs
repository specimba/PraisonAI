import { chromium } from "playwright";
const MIN = 60_000;
const browser = await chromium.launch({
  executablePath:
    "/home/z/.cache/ms-playwright/chromium_headless_shell-1200/chrome-headless-shell-linux64/chrome-headless-shell",
  args: ["--no-sandbox"],
});
const context = await browser.newContext();
const page = await context.newPage();
page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 300)));
page.on("console", (m) => {
  if (m.type() === "error" || m.type() === "warning")
    console.log(`[console.${m.type()}]`, m.text().slice(0, 300));
});
const seed = {
  state: {
    workflows: [
      {
        id: "rl-backoff",
        name: "Backoff Wf",
        description: "r171 fixture rl-backoff",
        steps: [{ id: "s1", agentId: "a1", label: "Only step" }],
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
for (let s = 1; s <= 16; s++) {
  await page.waitForTimeout(1000);
  if (s === 5 || s === 15) {
    const info = await page.evaluate(() => ({
      url: location.href,
      bodyText: (document.body.innerText ?? "").slice(0, 250).replace(/\n+/g, " | "),
      toasts: [...document.querySelectorAll("[data-sonner-toast]")].map((t) =>
        (t.textContent ?? "").slice(0, 90)
      ),
      navButtons: [...document.querySelectorAll("button")].length,
      wfKey: Object.keys(JSON.parse(localStorage.getItem("praison-workflows") ?? "{}").state ?? {}),
    }));
    console.log(`t=${s}s`, JSON.stringify(info));
  }
}
await browser.close();
