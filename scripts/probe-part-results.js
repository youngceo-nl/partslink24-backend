// Probe: reproduce the VIN → OEM search flow and dump the DOM of the
// results page so we can figure out what selectors actually match the
// rows. The existing parser looks for [data-test-id="row"] but returns
// zero results on the Mercedes catalog — this script tells us what to
// use instead.
//
// Output written to artifacts/screenshots/probe-part-results.{png,json}.

const fs = require("node:fs/promises");
const path = require("node:path");
const { withPage } = require("../src/services/browser");
const { ensureLoggedIn } = require("../src/services/partslink");
const { openCatalog, SEL } = require("../src/services/catalog");
const { validateVin } = require("../src/services/vin");

const VIN = process.argv[2] || "W1KAH4BB4RF148266";
const BRAND = process.argv[3] || "mercedes";
const PART = process.argv[4] || "A2239051109";

async function main() {
  await ensureLoggedIn();
  await withPage(async (page) => {
    await openCatalog(page, BRAND);

    const vinInput = page.locator(SEL.vinInput).first();
    await vinInput.waitFor({ state: "visible", timeout: 10_000 });
    await vinInput.fill(validateVin(VIN));
    const vinSubmit = page.locator(SEL.vinSubmit).first();
    if (await vinSubmit.isVisible({ timeout: 1500 }).catch(() => false)) {
      await vinSubmit.click();
    } else {
      await vinInput.press("Enter");
    }

    // Wait for companion to hydrate with the VIN.
    await page.waitForFunction(
      (v) => {
        const el = document.querySelector('[data-test-id="companion"]');
        return !!el && (el.innerText || "").includes(v);
      },
      VIN,
      { timeout: 25_000 },
    );
    console.log("[probe] vehicle context loaded");

    // Wait for the part-search input to hydrate.
    await page.locator(SEL.partInput).first()
      .waitFor({ state: "visible", timeout: 25_000 });
    console.log("[probe] part input visible");

    await page.locator(SEL.partInput).first().fill(PART);
    await page.locator(SEL.partInput).first().press("Enter");

    // Give the SPA time to route to /search?q=... and render rows.
    await page.waitForTimeout(5000);
    console.log("[probe] post-search URL:", page.url());

    // Screenshot + DOM dump.
    const shot = path.resolve(process.cwd(), "artifacts/screenshots/probe-part-results.png");
    await page.screenshot({ path: shot, fullPage: true });
    console.log("[probe] screenshot:", shot);

    const dump = await page.evaluate(() => {
      const pick = (sel, limit = 10) =>
        Array.from(document.querySelectorAll(sel))
          .slice(0, limit)
          .map((el) => ({
            tag: el.tagName.toLowerCase(),
            testId: el.getAttribute("data-test-id"),
            role: el.getAttribute("role"),
            classes: (el.className?.toString() || "").slice(0, 200),
            text: (el.innerText || "").replace(/\s+/g, " ").trim().slice(0, 300),
          }));

      // Find every element whose innerText includes the search query,
      // filtered to leaf-ish nodes (no huge parents).
      const query = "A2239051109";
      const hitMatches = Array.from(document.querySelectorAll("*"))
        .filter((el) => (el.innerText || "").includes(query))
        .filter((el) => {
          // Keep only elements whose own innerText matches AND that don't
          // have a matching descendant — i.e. the tightest match.
          const hasMatchingChild = Array.from(el.children).some(
            (c) => (c.innerText || "").includes(query),
          );
          return !hasMatchingChild;
        })
        .slice(0, 15)
        .map((el) => ({
          tag: el.tagName.toLowerCase(),
          testId: el.getAttribute("data-test-id"),
          classes: (el.className?.toString() || "").slice(0, 200),
          text: (el.innerText || "").replace(/\s+/g, " ").trim().slice(0, 300),
          ancestorTestIds: Array.from({ length: 8 }).reduce(
            (acc) => {
              const parent = acc.el?.parentElement;
              if (!parent) return acc;
              const tid = parent.getAttribute("data-test-id");
              if (tid) acc.ids.push(tid);
              return { el: parent, ids: acc.ids };
            },
            { el, ids: [] },
          ).ids,
        }));

      return {
        url: location.href,
        title: document.title,
        rowDataTestId: pick('[data-test-id="row"]', 5),
        rowsByClass: pick("[class*='row' i], [class*='Row']", 5),
        tables: pick("table", 3),
        tableRows: pick("tr", 10),
        divsWithDataTestId: pick("[data-test-id]", 40).filter((x) => x.testId),
        hitMatches,
      };
    });

    const out = path.resolve(process.cwd(), "artifacts/screenshots/probe-part-results.json");
    await fs.writeFile(out, JSON.stringify(dump, null, 2));
    console.log("[probe] dump:", out);
    console.log("[probe] rowDataTestId count:", dump.rowDataTestId.length);
    console.log("[probe] hitMatches (leaf elements containing query):", dump.hitMatches.length);
    for (const h of dump.hitMatches.slice(0, 6)) {
      console.log(`  - <${h.tag}> testId=${h.testId} classes="${h.classes.slice(0, 80)}"`);
      console.log(`    text="${h.text.slice(0, 120)}"`);
      console.log(`    ancestors=${JSON.stringify(h.ancestorTestIds)}`);
    }
    console.log("[probe] data-test-ids in doc (sample):");
    const seen = new Set();
    for (const d of dump.divsWithDataTestId) {
      if (!seen.has(d.testId)) {
        seen.add(d.testId);
        console.log(`  - ${d.testId}  <${d.tag}>  "${d.text.slice(0, 80)}"`);
      }
      if (seen.size >= 20) break;
    }
  });
}

main().then(() => process.exit(0)).catch((err) => {
  console.error("[probe] failed:", err);
  process.exit(1);
});
