// Direct-navigation probe against /login.do to understand why the server's
// login flow couldn't find the input field.
const fs = require("node:fs/promises");
const path = require("node:path");
const { chromium } = require("playwright");
require("dotenv").config();

const OUT = path.resolve(process.cwd(), "artifacts", "probe-direct");

(async () => {
  await fs.mkdir(OUT, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

  const url = `${process.env.PARTSLINK24_BASE_URL || "https://www.partslink24.com"}/partslink24/user/login.do`;
  console.log("[probe-direct] goto", url);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  console.log("[probe-direct] url after goto:", page.url());
  await page.waitForTimeout(3000);

  await page.screenshot({ path: path.join(OUT, "page.png"), fullPage: true });
  await fs.writeFile(path.join(OUT, "page.html"), await page.content());

  const probe = await page.evaluate(() => {
    const has = (sel) => !!document.querySelector(sel);
    return {
      url: location.href,
      title: document.title,
      hasAccountLogin: has('input[name="accountLogin"]'),
      hasUserLogin: has('input[name="userLogin"]'),
      hasPassword: has('input[name="loginBean.password"]'),
      bodyTextStart: (document.body?.innerText || "").slice(0, 400),
    };
  });
  console.log("[probe-direct] result:", JSON.stringify(probe, null, 2));
  await browser.close();
})();
