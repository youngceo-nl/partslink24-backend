// Probe script: open the Porsche catalog, click "Dealer selecteren",
// capture a screenshot + dump the modal DOM so we can see what selectors
// to drive. Safe to run — read-only from PL24's perspective.

const fs = require("node:fs/promises");
const path = require("node:path");
const { withPage } = require("../src/services/browser");
const { ensureLoggedIn } = require("../src/services/partslink");
const { openCatalog, SEL } = require("../src/services/catalog");

async function main() {
  await ensureLoggedIn();
  await withPage(async (page) => {
    await openCatalog(page, "porsche");
    await page.waitForTimeout(1500);

    const before = path.resolve(process.cwd(), "artifacts/screenshots/probe-before-dealer-click.png");
    await page.screenshot({ path: before, fullPage: true });
    console.log("[probe] catalog loaded, screenshot:", before);

    const btn = page.locator(SEL.noDealerBtn).first();
    const visible = await btn.isVisible({ timeout: 3000 }).catch(() => false);
    console.log("[probe] noDealerSelectedButton visible:", visible);
    if (!visible) {
      console.log("[probe] no dealer gate — search should already work. Exiting.");
      return;
    }

    await btn.click();
    await page.waitForTimeout(2500);

    const after = path.resolve(process.cwd(), "artifacts/screenshots/probe-after-dealer-click.png");
    await page.screenshot({ path: after, fullPage: true });
    console.log("[probe] after-click screenshot:", after);

    // Dump any visible dialog / modal / listbox.
    const modalInfo = await page.evaluate(() => {
      const candidates = Array.from(document.querySelectorAll(
        '[role="dialog"], [role="listbox"], [role="menu"], [data-test-id*="dealer" i], [class*="modal" i], [class*="Modal" i], [class*="dialog" i], [class*="Dialog" i]'
      ));
      return candidates.map((el) => ({
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute("role"),
        id: el.id || null,
        classes: el.className?.toString().slice(0, 200) || null,
        testId: el.getAttribute("data-test-id"),
        text: (el.innerText || "").slice(0, 600),
        childSample: Array.from(el.querySelectorAll("*"))
          .slice(0, 40)
          .map((c) => ({
            tag: c.tagName.toLowerCase(),
            role: c.getAttribute("role"),
            testId: c.getAttribute("data-test-id"),
            classes: (c.className?.toString() || "").slice(0, 120),
            text: (c.innerText || "").trim().slice(0, 80),
          })),
      }));
    });

    const out = path.resolve(process.cwd(), "artifacts/screenshots/probe-dealer-modal.json");
    await fs.writeFile(out, JSON.stringify(modalInfo, null, 2));
    console.log("[probe] modal DOM dump:", out);
    console.log("[probe] summary — candidate containers:", modalInfo.length);
    for (const m of modalInfo.slice(0, 6)) {
      console.log("  -", m.tag, "role=", m.role, "testId=", m.testId, "text=", m.text.slice(0, 120));
    }
  });
}

main().then(() => process.exit(0)).catch((err) => {
  console.error("[probe] failed:", err);
  process.exit(1);
});
