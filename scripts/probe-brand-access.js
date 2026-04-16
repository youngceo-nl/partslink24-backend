// Iterate over known brand slugs, open each catalog, and report:
//   - dealer required?
//   - VIN input disabled?
//   - "demo" watermark present?
// Uses the saved session so we don't re-login per brand.

const fs = require("node:fs/promises");
const path = require("node:path");
const { chromium } = require("playwright");
require("dotenv").config();

const SESSION_FILE = path.resolve(process.cwd(), "sessions", "partslink24.json");
const OUT = path.resolve(process.cwd(), "artifacts", "probe-brand-access");

const BRANDS = [
  "audi", "bmw", "mercedes", "porsche", "skoda", "seat",
  "hyundai", "kia", "toyota", "nissan", "volvo",
  "renault", "peugeot", "citroen", "opel", "fiatp", "fordp",
];

(async () => {
  await fs.mkdir(OUT, { recursive: true });
  const storageState = JSON.parse(await fs.readFile(SESSION_FILE, "utf8"));

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, storageState });
  const page = await ctx.newPage();
  page.setDefaultTimeout(20_000);

  const results = [];
  for (const brand of BRANDS) {
    const url = `https://www.partslink24.com/partslink24/launchCatalog.do?service=${brand}_parts`;
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 40_000 });
      await page.waitForTimeout(3500);

      // dismiss any cookie banner
      const cookieBtn = page.locator('#usercentrics-root button[data-testid="uc-accept-all-button"]').first();
      if (await cookieBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
        await cookieBtn.click().catch(() => {});
        await page.waitForTimeout(400);
      }

      const info = await page.evaluate(() => {
        const vin = document.querySelector('[data-test-id="vehicleSearchInput"] input');
        const part = document.querySelector('[data-test-id="partSearchInput"] input');
        const dealerBtn = document.querySelector('[data-test-id="noDealerSelectedButton"]');
        const brandLabel = document.querySelector('[data-test-id="breadcrumbCatalogName"]')?.innerText || null;
        const bodyTxt = (document.body?.innerText || "").toLowerCase();
        const demoHits = (bodyTxt.match(/\bdemo\b/g) || []).length;
        return {
          vinFound: !!vin,
          vinDisabled: vin?.disabled ?? null,
          partFound: !!part,
          partDisabled: part?.disabled ?? null,
          dealerButtonVisible: !!dealerBtn && getComputedStyle(dealerBtn).display !== "none",
          brandLabel,
          demoHits,
          error500: bodyTxt.includes("error 500") || bodyTxt.includes("unknown service"),
        };
      });

      const status = info.error500
        ? "no_service"
        : !info.vinFound
          ? "no_catalog_ui"
          : info.vinDisabled
            ? (info.demoHits >= 6 ? "demo" : "disabled")
            : "ready";
      results.push({ brand, status, ...info });
      console.log(`[${status.padEnd(14)}] ${brand.padEnd(10)} demoHits=${info.demoHits} label="${info.brandLabel}"`);
    } catch (err) {
      results.push({ brand, status: "probe_error", message: err.message });
      console.log(`[probe_error   ] ${brand}: ${err.message}`);
    }
  }

  await fs.writeFile(path.join(OUT, "summary.json"), JSON.stringify(results, null, 2));
  await browser.close();
})().catch((err) => { console.error(err); process.exit(1); });
