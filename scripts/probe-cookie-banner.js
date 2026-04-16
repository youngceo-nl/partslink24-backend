// Open a headed Chromium to the PartsLink24 login page (does NOT log in —
// just sits on the public page so the user can inspect the Usercentrics
// cookie banner's HTML). Paste the accept-button's outerHTML back to me.

const { chromium } = require("playwright-extra");
const stealth = require("puppeteer-extra-plugin-stealth")();
chromium.use(stealth);

(async () => {
  const browser = await chromium.launch({ headless: false });
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    locale: "nl-NL",
  });
  const page = await ctx.newPage();
  await page.goto("https://www.partslink24.com", {
    waitUntil: "domcontentloaded", timeout: 40_000,
  });
  await page.waitForTimeout(3000);

  console.log("\n🍪 Cookie banner should be visible.\n");
  console.log("  1. Right-click the banner's 'Accept' button → Inspect");
  console.log("  2. In DevTools, right-click the <button> → Copy → Copy outerHTML");
  console.log("  3. Paste it back to me\n");
  console.log("The browser stays open until you press Ctrl+C in this terminal.\n");

  await new Promise(() => {});
})().catch((err) => {
  console.error("[probe] failed:", err);
  process.exit(1);
});
