// Open catalog, click the "Dealer selecteren" button, and dump whatever
// modal/dropdown appears so we can understand the dealer-selection flow.
const fs = require("node:fs/promises");
const path = require("node:path");
const { chromium } = require("playwright");
require("dotenv").config();

const OUT = path.resolve(process.cwd(), "artifacts", "probe-dealer");
const SESSION_FILE = path.resolve(process.cwd(), "sessions", "partslink24.json");

(async () => {
  await fs.mkdir(OUT, { recursive: true });
  const storageState = JSON.parse(await fs.readFile(SESSION_FILE, "utf8"));

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, storageState });
  const page = await ctx.newPage();

  await page.goto("https://www.partslink24.com/partslink24/launchCatalog.do?service=mercedes_parts",
    { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(5000);

  console.log("[dealer] url:", page.url());
  await page.screenshot({ path: path.join(OUT, "01-catalog.png"), fullPage: true });

  const dealerBtn = page.locator('[data-test-id="noDealerSelectedButton"]');
  if (!(await dealerBtn.isVisible().catch(() => false))) {
    console.log("[dealer] noDealerSelectedButton not visible");
    await browser.close();
    return;
  }

  await dealerBtn.click();
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(OUT, "02-after-click.png"), fullPage: true });
  await fs.writeFile(path.join(OUT, "02-after-click.html"), await page.content());

  const modal = await page.evaluate(() => {
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const dialogs = Array.from(document.querySelectorAll("[role='dialog'], .MuiDialog-root, .MuiModal-root, .MuiPopover-root"))
      .filter(visible).map(d => ({
        tag: d.tagName,
        cls: d.className,
        innerText: (d.innerText || "").slice(0, 1500),
      }));
    const radios = Array.from(document.querySelectorAll("input[type='radio'], .MuiListItem-root, [role='option']"))
      .filter(visible).map(el => ({ tag: el.tagName, text: (el.innerText || el.value || "").slice(0, 120), testId: el.getAttribute("data-test-id") }))
      .slice(0, 20);
    const buttons = Array.from(document.querySelectorAll("button")).filter(visible).map(b => ({
      text: (b.innerText || "").trim().slice(0, 60),
      testId: b.getAttribute("data-test-id"),
    }));
    return { dialogs, radios, buttons };
  });
  await fs.writeFile(path.join(OUT, "02-modal-probe.json"), JSON.stringify(modal, null, 2));
  console.log("[dealer] dialogs:", modal.dialogs.length, "radios:", modal.radios.length);

  await browser.close();
})();
