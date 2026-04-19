// Fresh-login headed probe. Logs in from the laptop (not the Droplet, so
// not subject to whatever rate-limit PartsLink24 has on the server IP),
// lands on the vehicle page for a given VIN, and keeps the window open
// for interactive inspection.
//
// Also writes the resulting storageState to sessions/partslink24.json so
// you can `scp` it back to the Droplet and skip fresh login there:
//   scp ./sessions/partslink24.json root@188.166.72.34:/root/partslink24-backend/sessions/
//   ssh root@188.166.72.34 'cd partslink24-backend && docker compose restart api'

const fs = require("node:fs/promises");
const path = require("node:path");
const { chromium } = require("playwright-extra");
const stealth = require("puppeteer-extra-plugin-stealth")();
chromium.use(stealth);
require("dotenv").config();

const VIN = process.argv[2] || "WP0AF2A99KS165242";
const SESSION_FILE = path.resolve(process.cwd(), "sessions", "partslink24.json");

async function main() {
  const co = process.env.PARTSLINK24_COMPANY_ID;
  const un = process.env.PARTSLINK24_USERNAME;
  const pw = process.env.PARTSLINK24_ACCESS_CODE;
  if (!co || !un || !pw) { console.error("Missing creds in .env"); process.exit(1); }

  const browser = await chromium.launch({ headless: false });
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    locale: "nl-NL",
  });
  // Block Usercentrics' CDN scripts entirely — if their JS never loads,
  // the cookie banner can't render. This is more reliable than trying to
  // remove the DOM elements after the fact (they re-inject faster than a
  // MutationObserver can delete).
  await ctx.route(/usercentrics\.(eu|com|org)|app\.usercentrics|uc-api/i, (route) => route.abort());
  const page = await ctx.newPage();

  console.log("[probe] logging in…");
  await page.goto("https://www.partslink24.com", { waitUntil: "domcontentloaded", timeout: 40_000 });
  await page.waitForSelector('input[name="accountLogin"]', { timeout: 15_000 });

  // Dismiss Usercentrics cookie banner (out-of-viewport — use JS API).
  await page.evaluate(() => {
    const ui = window.UC_UI;
    if (ui?.acceptAllConsents) ui.acceptAllConsents().catch(() => {});
    else if (ui?.closeCMP) ui.closeCMP();
  }).catch(() => {});
  await page.waitForTimeout(300);

  // 80ms delay + explicit click to focus — fast typing + onkeyup="txtChanged()"
  // caused characters to drop (company ID came out as "nl-62" instead of
  // "nl-620935"). Slower typing stays reliable.
  for (const [sel, val] of [
    ['input[name="accountLogin"]', co],
    ['input[name="userLogin"]', un],
    ['input[name="loginBean.password"]', pw],
  ]) {
    await page.locator(sel).click();
    await page.locator(sel).pressSequentially(val, { delay: 80 });
  }
  await page.evaluate(() => { if (typeof txtChanged === "function") txtChanged(); });

  // Usercentrics can re-show the banner after we've typed (it initializes
  // asynchronously and re-runs its consent check). Dismiss again before
  // submitting so the login form isn't blocked.
  await page.evaluate(() => {
    const ui = window.UC_UI;
    if (ui?.acceptAllConsents) ui.acceptAllConsents().catch(() => {});
    else if (ui?.closeCMP) ui.closeCMP();
  }).catch(() => {});
  await page.waitForTimeout(400);

  await page.evaluate(() => { if (typeof doLoginAjax === "function") doLoginAjax(false); });

  // Handle squeeze-out prompt ("Wilt u de actuele sessie beëindigen?")
  await page.waitForTimeout(1500);
  const squeezeVisible = await page.evaluate(() => {
    const el = document.getElementById("sessionSqueezeOutPrompt");
    return !!el && getComputedStyle(el).display !== "none";
  }).catch(() => false);
  if (squeezeVisible) {
    console.log("[probe] squeeze-out → confirming");
    await page.evaluate(() => { if (typeof doLoginAjax === "function") doLoginAjax(true); });
  }

  await page.waitForSelector('form[name="search-text"] input[name="text"]', { timeout: 30_000 });
  console.log("[probe] logged in, entering VIN:", VIN);

  await page.locator('form[name="search-text"] input[name="text"]').fill(VIN);
  await page.evaluate(() => { if (typeof searchText === "function") searchText(); });
  await page.waitForURL(/\/pl24-app\//, { timeout: 30_000 }).catch(() => {});
  await page.waitForTimeout(4000);

  // Persist cookies so the Droplet can reuse them.
  await fs.mkdir(path.dirname(SESSION_FILE), { recursive: true });
  await fs.writeFile(SESSION_FILE, JSON.stringify(await ctx.storageState()), "utf8");
  console.log(`[probe] session saved to ${SESSION_FILE}`);

  console.log(`\n🔍 Vehicle page: ${page.url()}`);
  console.log("\nExplore the catalog. Right-click → Inspect to copy any HTML. Ctrl+C to exit.\n");

  await new Promise(() => {});
}

main().catch((err) => {
  console.error("[probe] failed:", err);
  process.exit(1);
});
