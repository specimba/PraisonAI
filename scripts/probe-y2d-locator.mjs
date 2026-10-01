#!/usr/bin/env node
// r165 probe: why did Y2d's card locator miss? (one-off, kept for reuse)
import { chromium } from "playwright";
const browser = await chromium.launch({
  executablePath: "/home/z/.cache/ms-playwright/chromium_headless_shell-1200/chrome-headless-shell-linux64/chrome-headless-shell",
  args: ["--no-sandbox"],
});
const page = await (await browser.newContext()).newPage();
await page.goto("http://localhost:3000/", { waitUntil: "domcontentloaded" });
const nav = page.getByRole("button", { name: /^Settings/ }).first();
await nav.click();
await page.getByText("Free frontier providers").first().waitFor({ timeout: 20000 });
const input = page.locator("#providers input[type='file']");
await input.setInputFiles({ name: "v.json", mimeType: "application/json",
  buffer: Buffer.from(JSON.stringify({ providerKeys: { groq: { key: "gsk_x", model: "m" } }, activeProviderId: "groq", provider: "custom", defaultModel: "m" })) });
await page.waitForTimeout(900);
console.log("active-provider buttons:", await page.getByRole("button", { name: "Active provider" }).count());
console.log("rounded-xl.border divs:", await page.locator("div.rounded-xl.border").count());
const first = page.locator("div.rounded-xl", { hasText: "Groq" }).first();
console.log("first rounded-xl w/ Groq — classes:", (await first.getAttribute("class"))?.slice(0, 80));
console.log("Active btns inside first:", await first.getByRole("button", { name: "Active provider" }).count());
const header = page.locator("button[aria-expanded]", { hasText: "Groq" }).first();
console.log("header btn found:", await header.count());
const card = header.locator("xpath=..");
console.log("card has Active btn:", await card.getByRole("button", { name: "Active provider" }).count());
await browser.close();
