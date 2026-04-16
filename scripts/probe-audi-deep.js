// Deep look at Audi catalog — screenshot, dump all buttons + tooltips,
// so we can figure out WHY the VIN input is disabled.
const fs = require("node:fs/promises");
const path = require("node:path");
const { chromium } = require("playwright");
require("dotenv").config();

const SESSION_FILE = path.resolve(process.cwd(), "sessions", "partslink24.json");
const OUT = path.resolve(process.cwd(), "artifacts", "probe-audi-deep");

(async () => {
  await fs.mkdir(OUT, { recursive: true });
  const storageState = JSON.parse(await fs.readFile(SESSION_FILE, "utf8"));

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, storageState });
  const page = await ctx.newPage();

  await page.goto("https://www.partslink24.com/partslink24/launchCatalog.do?service=audi_parts",
    { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(4500);

  // dismiss cookies
  const cookie = page.locator('#usercentrics-root button[data-testid="uc-accept-all-button"]').first();
  if (await cookie.isVisible({ timeout: 1500 }).catch(() => false)) {
    await cookie.click();
    await page.waitForTimeout(500);
  }

  await page.screenshot({ path: path.join(OUT, "01-initial.png"), fullPage: true });

  const info = await page.evaluate(() => {
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };

    // Dump every button with its text/testid + location
    const buttons = Array.from(document.querySelectorAll("button, [role='button'], .MuiButton-root"))
      .filter(visible)
      .map(el => ({
        text: (el.innerText || el.getAttribute("aria-label") || "").trim().slice(0, 100),
        testId: el.getAttribute("data-test-id") || el.getAttribute("data-testid"),
        disabled: el.disabled ?? null,
      }));

    // VIN input surrounding context (tooltip, disabled reason)
    const vinInput = document.querySelector('[data-test-id="vehicleSearchInput"] input');
    const vinContainer = document.querySelector('[data-test-id="vehicleSearchInput"]');
    const vinContext = vinContainer ? {
      title: vinContainer.getAttribute("title"),
      ariaLabel: vinContainer.getAttribute("aria-label"),
      surrounding: vinContainer.parentElement?.innerText?.slice(0, 400),
    } : null;

    // Any error / warning banners on the page
    const banners = Array.from(document.querySelectorAll(".MuiAlert-root, [role='alert'], .errorMessage, .warning, [class*='banner'], [class*='notice']"))
      .filter(visible)
      .map(el => el.innerText.slice(0, 300));

    // Any tabs or menu items that might lead to enabling search
    const menuItems = Array.from(document.querySelectorAll("[data-test-id*='CompanionBarItem'], [data-test-id*='menu-item']"))
      .filter(visible)
      .map(el => ({
        testId: el.getAttribute("data-test-id"),
        label: el.getAttribute("aria-label"),
        className: el.className.slice(0, 100),
      }));

    return { url: location.href, title: document.title, buttons, vinContext, banners, menuItems };
  });
  await fs.writeFile(path.join(OUT, "01-info.json"), JSON.stringify(info, null, 2));
  console.log("[deep] buttons:", info.buttons.length);
  console.log("[deep] banners:", info.banners);
  console.log("[deep] menuItems:", JSON.stringify(info.menuItems, null, 2).slice(0, 500));
  console.log("[deep] vinContext:", JSON.stringify(info.vinContext, null, 2));

  // Try clicking "openMenu" to see what's inside
  const menuBtn = page.locator('[data-test-id="openMenu"]').first();
  if (await menuBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
    await menuBtn.click();
    await page.waitForTimeout(1200);
    await page.screenshot({ path: path.join(OUT, "02-menu-open.png"), fullPage: true });
    const menuInfo = await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll("li, .MuiMenuItem-root, [role='menuitem']"))
        .filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
        .map(el => ({
          text: el.innerText.trim().slice(0, 100),
          testId: el.getAttribute("data-test-id") || el.getAttribute("data-testid"),
        }));
      return { items: items.slice(0, 30) };
    });
    await fs.writeFile(path.join(OUT, "02-menu.json"), JSON.stringify(menuInfo, null, 2));
    console.log("[deep] menu items:", JSON.stringify(menuInfo, null, 2));
  }

  await browser.close();
})().catch(err => { console.error(err); process.exit(1); });
