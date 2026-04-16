// Probe /partslink24/startup.do — the authenticated portal home with the
// global VIN search form. Logs in fresh since session cookies don't always
// persist across new browser instances.
const fs = require("node:fs/promises");
const path = require("node:path");
const { chromium } = require("playwright");
require("dotenv").config();

const OUT = path.resolve(process.cwd(), "artifacts", "probe-startup");

(async () => {
  await fs.mkdir(OUT, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

  // Fresh login — mirrors src/services/partslink.js.
  await page.goto("https://www.partslink24.com", { waitUntil: "domcontentloaded", timeout: 40_000 });
  await page.waitForSelector('input[name="accountLogin"]', { timeout: 15_000 });
  await page.fill('input[name="accountLogin"]', process.env.PARTSLINK24_COMPANY_ID);
  await page.fill('input[name="userLogin"]', process.env.PARTSLINK24_USERNAME);
  await page.fill('input[name="loginBean.password"]', process.env.PARTSLINK24_ACCESS_CODE);
  await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {}),
    page.evaluate(() => document.forms["loginForm"]?.submit()),
  ]);
  await page.waitForTimeout(3000);
  console.log("[startup] post-login url:", page.url());
  await page.screenshot({ path: path.join(OUT, "00-after-login.png"), fullPage: true });

  // If we're on the "Attention" interstitial, follow the Reload link.
  if ((await page.title()).includes("Attention")) {
    const reload = await page.locator('a[href*="startup.do?arid="]').first().getAttribute("href");
    console.log("[startup] following reload link:", reload);
    if (reload) await page.goto(reload, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(2500);
  }

  console.log("[startup] url:", page.url());
  await page.screenshot({ path: path.join(OUT, "01-startup.png"), fullPage: true });
  await fs.writeFile(path.join(OUT, "01-startup.html"), await page.content());

  const info = await page.evaluate(() => {
    const vin = document.querySelector('form[name="search-text"] input[name="text"]');
    const hiddenSubmit = document.querySelector('form[name="search-text"] input#hidden-search');
    const searchBtn = document.querySelector('form[name="search-text"] .search-btn');
    return {
      url: location.href,
      title: document.title,
      hasVinInput: !!vin,
      hasHiddenSubmit: !!hiddenSubmit,
      hasSearchBtn: !!searchBtn,
      vinAttrs: vin ? { name: vin.name, type: vin.type, maxLength: vin.maxLength, placeholder: vin.placeholder, disabled: vin.disabled } : null,
    };
  });
  console.log("[startup] info:", JSON.stringify(info, null, 2));

  if (info.hasVinInput && !info.vinAttrs.disabled) {
    const vin = "WDDGJ4HB2FG386566";
    console.log("[startup] filling VIN:", vin);
    await page.locator('form[name="search-text"] input[name="text"]').fill(vin);
    await page.waitForTimeout(400);
    await page.evaluate(() => { if (typeof searchText === "function") searchText(); });
    await page.waitForTimeout(6000);
    console.log("[startup] after search url:", page.url());
    await page.screenshot({ path: path.join(OUT, "02-after-vin-search.png"), fullPage: true });
    await fs.writeFile(path.join(OUT, "02-after.html"), await page.content());
  }

  await browser.close();
})().catch(err => { console.error(err); process.exit(1); });
