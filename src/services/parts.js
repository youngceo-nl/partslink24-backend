// Part-number lookup against PartsLink24 SPA catalogs.
//
// Flow (verified 2026-04-16 against audi_parts):
//   1. Resolve brand: from an explicit `brand` arg, or derived from VIN WMI.
//   2. Ensure logged in.
//   3. If VIN: enter it on /startup.do so the portal lands us inside the
//      right catalog with vehicle context. If no VIN: open the catalog
//      directly (the search UI may require dealer/vehicle context).
//   4. Enter the OEM into the catalog's part-search input and submit.
//   5. Parse the results list from stable data-test-ids:
//        [data-test-id="row"]
//          └── partnoValue / nameValue / mgValue / sgValue / btnrValue
//   6. Click the first row → land on the illustration page.
//   7. Read the exploded-view canvas from the <imageserver-weco> custom
//      element's **open shadow DOM** (`shadowRoot.querySelector("canvas")`),
//      toDataURL it, write to artifacts/part-images/{brand}-{oem}.png.
//   8. Return structured { partNumber, description, mainGroup (category),
//      mg, sg, illustration, partImageUrl }.

const fs = require("node:fs/promises");
const path = require("node:path");
const config = require("../config");
const log = require("../utils/logger");
const { withPage } = require("./browser");
const { ensureLoggedIn } = require("./partslink");
const { brandForVin, validateVin } = require("./vin");
const { UpstreamError, ValidationError } = require("../utils/errors");
const { captureFailure } = require("../utils/screenshot");

const GLOBAL_VIN_INPUT = 'form[name="search-text"] input[name="text"]';
const PART_INPUT = '[data-test-id="partSearchInput"] input';
const BRAND_BREADCRUMB = '[data-test-id="breadcrumbCatalogName"]';
const CATALOG_URL = (brand) =>
  `${config.partslink24.baseUrl}/partslink24/launchCatalog.do?service=${encodeURIComponent(`${brand}_parts`)}`;

const PART_IMAGES_DIR = path.resolve(process.cwd(), "artifacts", "part-images");

function normalizePartNumber(raw) {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new ValidationError("partNumber is required");
  }
  return raw.trim();
}

function slugifyForFile(raw) {
  return raw.replace(/[^A-Za-z0-9-]/g, "_").slice(0, 80);
}

function resolveBrand({ vin, brand }) {
  if (brand && typeof brand === "string") return brand.toLowerCase().trim();
  if (vin) return brandForVin(validateVin(vin));
  return null;
}

async function lookupPart({ vin, brand, partNumber }) {
  const partNo = normalizePartNumber(partNumber);
  const effectiveBrand = resolveBrand({ vin, brand });
  if (!effectiveBrand) {
    throw new ValidationError(
      "Cannot resolve PartsLink24 catalog — pass either a decodable VIN or an explicit `brand`",
    );
  }
  const login = await ensureLoggedIn();

  return withPage(async (page) => {
    try {
      // Step 1 — route via VIN to land in the right catalog with vehicle
      // context. Without a VIN the catalog sometimes hides part search.
      if (vin) {
        const valid = validateVin(vin);
        await page.goto(config.partslink24.baseUrl, { waitUntil: "domcontentloaded" });
        const formVisible = await page
          .waitForSelector(GLOBAL_VIN_INPUT, { timeout: 8000 })
          .then(() => true).catch(() => false);
        if (!formVisible) {
          log.warn("partslink.part.session_stale", { partNo, brand: effectiveBrand });
          await ensureLoggedIn({ force: true });
          await page.goto(config.partslink24.baseUrl, { waitUntil: "domcontentloaded" });
          await page.waitForSelector(GLOBAL_VIN_INPUT, { timeout: 20_000 });
        }
        await page.locator(GLOBAL_VIN_INPUT).first().fill(valid);
        await Promise.all([
          page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 20_000 }).catch(() => {}),
          page.evaluate(() => { if (typeof searchText === "function") searchText(); }),
        ]);
      } else {
        await page.goto(CATALOG_URL(effectiveBrand), { waitUntil: "domcontentloaded" });
      }

      // Step 2 — wait for catalog SPA to hydrate.
      await page.waitForSelector(BRAND_BREADCRUMB, { timeout: 20_000 }).catch(() => {});

      // Step 3 — surface dealer-gate early so callers see a clean error.
      const partVisible = await page.locator(PART_INPUT).first()
        .isVisible({ timeout: 6000 }).catch(() => false);
      if (!partVisible) {
        const needsDealer = await page.evaluate(() => {
          return Array.from(document.querySelectorAll("button"))
            .some((b) => /select dealer|dealer selecteren/i.test(b.innerText || ""));
        }).catch(() => false);
        const screenshot = await captureFailure(page, `part-gated-${effectiveBrand}`);
        throw new UpstreamError(
          needsDealer
            ? "PartsLink24 requires a dealer to be selected before part search is available. Sign in via the web UI and pick a default dealer once."
            : "Part-search input is hidden — the catalog UI state prevents automated search (dealer/vehicle context missing).",
          {
            brand: effectiveBrand,
            code: needsDealer ? "dealer_selection_required" : "part_input_hidden",
            screenshot,
          },
        );
      }

      // Step 4 — submit the OEM query.
      await page.locator(PART_INPUT).first().fill(partNo);
      await page.locator(PART_INPUT).first().press("Enter");
      await page.waitForTimeout(2500);

      // Step 5 — parse result rows from stable data-test-ids.
      const results = await page.evaluate(() => {
        const text = (el) => (el?.innerText || "").replace(/\s+/g, " ").trim();
        const pick = (row, testId) => text(row.querySelector(`[data-test-id="${testId}"] ._value_15k4v_1`)
          || row.querySelector(`[data-test-id="${testId}"] span`));
        const rows = Array.from(document.querySelectorAll('[data-test-id="row"]'))
          .map((row) => ({
            partNo: pick(row, "partnoValue"),
            description: pick(row, "nameValue"),
            mg: pick(row, "mgValue"),
            sg: pick(row, "sgValue"),
            illustration: pick(row, "btnrValue"),
          }))
          .filter((r) => r.partNo);

        // Map main-group code → name from the right-side table
        // ("1 Engine", "9 Electrics", "0 Access./Infotainment/cell.").
        const mgMap = {};
        for (const row of document.querySelectorAll('[data-test-id="row"], tr')) {
          const t = text(row);
          const m = t.match(/^(\d)\s+(.+?)(\s{2}|$)/);
          if (m && !mgMap[m[1]]) mgMap[m[1]] = m[2].slice(0, 60);
        }
        return { rows, mgMap };
      });

      const first = results.rows[0] || null;
      const mainGroup = first?.mg ? (results.mgMap[first.mg] ?? null) : null;

      // Step 6+7 — click the first row + extract the shadow-DOM canvas.
      let partImageUrl = null;
      if (first) {
        await page.locator('[data-test-id="row"]').first().click().catch(() => {});
        // Give the <imageserver-weco> web component + its canvas time to
        // render. The canvas is sized before it's drawn into, so waiting
        // for width/height isn't enough — poll until the dataURL exceeds
        // the known "blank" size (an empty same-dim canvas is <3 KB base64
        // vs. ~120 KB when the diagram is drawn).
        const canvasData = await page.waitForFunction(() => {
          const host = document.querySelector("imageserver-weco");
          const c = host?.shadowRoot?.querySelector("canvas.draw-target")
            || host?.shadowRoot?.querySelector("canvas");
          if (!c || c.width < 50 || c.height < 50) return null;
          const url = c.toDataURL("image/png");
          // A blank transparent/white canvas is ~5-10KB; real diagrams are
          // 50KB+. Require >=15KB base64 to be confident pixels are drawn.
          return url.length > 15_000 ? url : null;
        }, undefined, { timeout: 20_000, polling: 500 })
          .then((h) => h.jsonValue())
          .catch(() => null);

        if (canvasData && typeof canvasData === "string" && canvasData.startsWith("data:image/")) {
          const b64 = canvasData.split(",", 2)[1];
          const buf = Buffer.from(b64, "base64");
          await fs.mkdir(PART_IMAGES_DIR, { recursive: true });
          const file = path.join(
            PART_IMAGES_DIR,
            `${effectiveBrand}-${slugifyForFile(partNo)}.png`,
          );
          await fs.writeFile(file, buf);
          partImageUrl = `/part-images/${path.basename(file)}`;
          log.info("partslink.part.image_captured", { brand: effectiveBrand, partNo, bytes: buf.length });
        } else {
          log.warn("partslink.part.image_missing", { brand: effectiveBrand, partNo });
        }
      }

      log.info("partslink.part.lookup.ok", {
        brand: effectiveBrand, partNo, resultCount: results.rows.length, partImageUrl,
      });

      return {
        partNumber: partNo,
        brand: effectiveBrand,
        vin: vin ?? null,
        name: first?.description ?? null,
        description: first?.description ?? null,
        imageUrl: partImageUrl,
        category: mainGroup,
        mainGroupNumber: first?.mg ?? null,
        subGroupNumber: first?.sg ?? null,
        illustrationNumber: first?.illustration ?? null,
        alternatives: results.rows.slice(1).map((r) => ({
          partNumber: r.partNo,
          description: r.description,
          illustration: r.illustration,
        })),
        compatibleVehicles: [],
        meta: {
          resolved: !!first,
          url: page.url(),
          sessionReused: login.sessionReused,
        },
      };
    } catch (err) {
      if (err.code === "dealer_selection_required" || err.code === "part_input_hidden") throw err;
      const screenshot = await captureFailure(page, `part-${effectiveBrand}`);
      log.error("partslink.part.lookup.failed", {
        brand: effectiveBrand, partNo, message: err.message, screenshot,
      });
      throw new UpstreamError("Part lookup failed", {
        brand: effectiveBrand, partNo, message: err.message, screenshot,
      });
    }
  });
}

module.exports = { lookupPart, normalizePartNumber };
