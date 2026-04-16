// Check whether the part-number search input is enabled (it has a separate
// data-test-id from the VIN input) — demo accounts may still allow this.
const fs = require("node:fs/promises");
const path = require("node:path");
const { chromium } = require("playwright");
require("dotenv").config();

const SESSION_FILE = path.resolve(process.cwd(), "sessions", "partslink24.json");
const OUT = path.resolve(process.cwd(), "artifacts", "probe-part-input");

const BRANDS = ["audi", "bmw", "mercedes", "porsche", "skoda", "seat", "toyota", "renault"];

(async () => {
  await fs.mkdir(OUT, { recursive: true });
  const storageState = JSON.parse(await fs.readFile(SESSION_FILE, "utf8"));

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, storageState });
  const page = await ctx.newPage();
  page.setDefaultTimeout(20_000);

  for (const brand of BRANDS) {
    await page.goto(`https://www.partslink24.com/partslink24/launchCatalog.do?service=${brand}_parts`,
      { waitUntil: "domcontentloaded", timeout: 40_000 });
    await page.waitForTimeout(3500);

    const cookie = page.locator('#usercentrics-root button[data-testid="uc-accept-all-button"]').first();
    if (await cookie.isVisible({ timeout: 1000 }).catch(() => false)) {
      await cookie.click().catch(() => {});
      await page.waitForTimeout(400);
    }

    const state = await page.evaluate(() => {
      const vin = document.querySelector('[data-test-id="vehicleSearchInput"] input');
      const part = document.querySelector('[data-test-id="partSearchInput"] input');
      const partContainer = document.querySelector('[data-test-id="partSearchInput"]');
      const partContainerHidden = partContainer ? getComputedStyle(partContainer).display === "none" : null;
      return {
        vinFound: !!vin,
        vinDisabled: vin?.disabled ?? null,
        partFound: !!part,
        partDisabled: part?.disabled ?? null,
        partContainerHidden,
      };
    });
    console.log(`${brand.padEnd(10)} vin:disabled=${state.vinDisabled}  part:found=${state.partFound} disabled=${state.partDisabled} hidden=${state.partContainerHidden}`);
  }
  await browser.close();
})().catch(err => { console.error(err); process.exit(1); });
