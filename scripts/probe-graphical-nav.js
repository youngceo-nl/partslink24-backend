// Reuses the Droplet session, opens the vehicle page, clicks the
// "Graphical Navigation" icon (the images icon that reveals the Scope
// panel), and dumps the loaded HTML + any <img> URLs so we can extract
// the vehicle image for the frontend.

const fs = require("node:fs/promises");
const path = require("node:path");
const { chromium } = require("playwright-extra");
const stealth = require("puppeteer-extra-plugin-stealth")();
chromium.use(stealth);

const VIN = process.argv[2] || "WP0AF2A99KS165242";
const OUT = path.resolve(process.cwd(), "artifacts", "probe-graphical-nav");
const SESSION_FILE = path.resolve(process.cwd(), "sessions", "partslink24.json");

async function main() {
  await fs.mkdir(OUT, { recursive: true });
  const storageState = JSON.parse(await fs.readFile(SESSION_FILE, "utf8"));

  const browser = await chromium.launch({ headless: false });
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    locale: "nl-NL",
    storageState,
  });
  const page = await ctx.newPage();

  await page.goto("https://www.partslink24.com", { waitUntil: "domcontentloaded", timeout: 40_000 });
  await page.waitForSelector('form[name="search-text"] input[name="text"]', { timeout: 20_000 });
  await page.locator('form[name="search-text"] input[name="text"]').fill(VIN);
  await page.evaluate(() => { if (typeof searchText === "function") searchText(); });
  await page.waitForURL(/\/pl24-app\//, { timeout: 30_000 }).catch(() => {});
  await page.waitForTimeout(4000);
  console.log("[probe] vehicle page:", page.url());

  // Click the "Graphical Navigation" icon — targeting the stable aria-label.
  const trigger = page.locator('[aria-label="Graphical Navigation"]').first();
  await trigger.waitFor({ state: "visible", timeout: 10_000 });
  console.log("[probe] clicking Graphical Navigation…");
  await trigger.click();
  await page.waitForTimeout(3500);

  await page.screenshot({ path: path.join(OUT, "after-click.png"), fullPage: true });

  // Grab every visible <img> with its dimensions + URL so we can pick the
  // vehicle hero image from the set.
  const images = await page.evaluate(() => {
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      return r.width > 50 && r.height > 50;
    };
    return Array.from(document.querySelectorAll("img"))
      .filter(visible)
      .map((img) => ({
        src: img.src,
        naturalWidth: img.naturalWidth,
        naturalHeight: img.naturalHeight,
        alt: img.alt || null,
        className: img.className.slice(0, 120),
        // walk up 3 parents to collect context classes
        ancestry: (() => {
          const out = [];
          let el = img.parentElement;
          for (let i = 0; i < 4 && el; i++) {
            out.push({ tag: el.tagName.toLowerCase(), cls: el.className?.slice?.(0, 120) || "" });
            el = el.parentElement;
          }
          return out;
        })(),
      }));
  });
  await fs.writeFile(path.join(OUT, "images.json"), JSON.stringify(images, null, 2));
  console.log(`[probe] found ${images.length} visible images (≥50px):`);
  for (const img of images) {
    console.log(`  ${img.naturalWidth}×${img.naturalHeight}  ${img.src.slice(0, 120)}`);
  }

  // Also dump the scope container HTML if present.
  const scopeHtml = await page.evaluate(() => {
    const el = document.querySelector('[class*="_container_116af"]');
    return el?.outerHTML?.slice(0, 20000) || null;
  });
  if (scopeHtml) {
    await fs.writeFile(path.join(OUT, "scope-panel.html"), scopeHtml);
    console.log(`[probe] dumped scope-panel HTML to ${path.join(OUT, "scope-panel.html")}`);
  } else {
    console.log("[probe] no element matched [class*='_container_116af']");
  }

  console.log("\n🔍 Browser stays open. Ctrl+C when done.");
  await new Promise(() => {});
}

main().catch((err) => {
  console.error("[probe] failed:", err);
  process.exit(1);
});
