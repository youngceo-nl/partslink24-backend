// Open a headed Chromium already logged in (reuses the Droplet's session
// cookies from sessions/partslink24.json), route to the vehicle page for
// a given VIN, and keep the window open so you can right-click → Inspect.
//
// Why session reuse: PartsLink24 has concurrent-session squeeze-out, and
// the deployed Droplet is holding a session. Logging in a second time
// from our laptop would kick the Droplet off (and vice-versa). Reusing
// the saved storageState keeps both sides happy.
//
// Usage:
//   node scripts/probe-vehicle-image.js [VIN]
//   (defaults to the Porsche GT3 RS test VIN)

const fs = require("node:fs/promises");
const path = require("node:path");
const { chromium } = require("playwright-extra");
const stealth = require("puppeteer-extra-plugin-stealth")();
chromium.use(stealth);

const VIN = process.argv[2] || "WP0AF2A99KS165242";
const SESSION_FILE = path.resolve(process.cwd(), "sessions", "partslink24.json");

async function main() {
  let storageState;
  try {
    storageState = JSON.parse(await fs.readFile(SESSION_FILE, "utf8"));
  } catch {
    console.error(
      `No session file at ${SESSION_FILE}. Copy one from the deployed Droplet first:\n` +
      "  scp root@188.166.72.34:/root/partslink24-backend/sessions/partslink24.json " +
      "./sessions/partslink24.json",
    );
    process.exit(1);
  }

  const browser = await chromium.launch({ headless: false });
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    locale: "nl-NL",
    storageState,
  });
  const page = await ctx.newPage();

  console.log("\n[probe] going to portal home…");
  await page.goto("https://www.partslink24.com", { waitUntil: "domcontentloaded", timeout: 40_000 });
  await page.waitForTimeout(2500);

  // Either the authenticated portal renders directly, or we hit login — tell
  // the caller which it is so they can decide.
  const onLogin = await page.locator('input[name="accountLogin"]').isVisible({ timeout: 2000 }).catch(() => false);
  if (onLogin) {
    console.error("[probe] session expired — you'll need to re-scp the session file from the Droplet.");
    await browser.close();
    process.exit(2);
  }

  await page.waitForSelector('form[name="search-text"] input[name="text"]', { timeout: 20_000 });
  console.log("[probe] session reused, entering VIN:", VIN);
  await page.locator('form[name="search-text"] input[name="text"]').fill(VIN);
  await page.evaluate(() => { if (typeof searchText === "function") searchText(); });

  await page.waitForURL(/\/pl24-app\//, { timeout: 30_000 }).catch(() => {});
  await page.waitForTimeout(4000);

  console.log(`\n🔍 Vehicle page open: ${page.url()}`);
  console.log("\nNext steps:");
  console.log("  1. Right-click the image/element you want → Inspect");
  console.log("  2. In DevTools, right-click the <element> → Copy → Copy outerHTML");
  console.log("  3. Paste it back to me");
  console.log("\nThe browser stays open until you press Ctrl+C in this terminal.\n");

  await new Promise(() => {});
}

main().catch((err) => {
  console.error("[probe] failed:", err);
  process.exit(1);
});
