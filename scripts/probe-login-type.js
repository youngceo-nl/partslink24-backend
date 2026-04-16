// Debug: type the credentials but screenshot BEFORE submit so we can see
// what's actually in the fields.
const fs = require("node:fs/promises");
const path = require("node:path");
const { chromium } = require("playwright");
require("dotenv").config();

const OUT = path.resolve(process.cwd(), "artifacts", "probe-login-type");

(async () => {
  await fs.mkdir(OUT, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  });
  const page = await ctx.newPage();
  await page.goto("https://www.partslink24.com", { waitUntil: "domcontentloaded", timeout: 40_000 });
  await page.waitForSelector('input[name="accountLogin"]', { timeout: 15_000 });

  const co = process.env.PARTSLINK24_COMPANY_ID;
  const un = process.env.PARTSLINK24_USERNAME;
  const pw = process.env.PARTSLINK24_ACCESS_CODE;
  console.log("credentials lengths:", co.length, un.length, pw.length);

  await page.locator('input[name="accountLogin"]').click();
  await page.locator('input[name="accountLogin"]').pressSequentially(co, { delay: 30 });
  await page.locator('input[name="userLogin"]').click();
  await page.locator('input[name="userLogin"]').pressSequentially(un, { delay: 30 });
  await page.locator('input[name="loginBean.password"]').click();
  await page.locator('input[name="loginBean.password"]').pressSequentially(pw, { delay: 30 });

  const values = await page.evaluate(() => ({
    accountLogin: document.querySelector('input[name="accountLogin"]').value,
    userLogin: document.querySelector('input[name="userLogin"]').value,
    password: document.querySelector('input[name="loginBean.password"]').value,
    loginBtnDisabled: document.querySelector('#login-btn')?.className?.includes("disabled"),
  }));
  console.log("typed values:", values);
  await page.screenshot({ path: path.join(OUT, "01-before-submit.png"), fullPage: true });

  await browser.close();
})().catch(err => { console.error(err); process.exit(1); });
