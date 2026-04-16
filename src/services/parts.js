// Part-number lookup against PartsLink24 brand catalogs.
//
// Flow:
//   1. Resolve the brand (either explicit or via VIN WMI).
//   2. Ensure login.
//   3. Open the brand catalog.
//   4. If a VIN was supplied, enter it first so the catalog narrows results
//      to that vehicle's parts. If no VIN, the part search runs across the
//      whole catalog.
//   5. Enter the part number, submit, wait for the results list, and extract
//      the first result's metadata.
//
// Same dealer-selection constraint as VIN decoding — if no dealer is set the
// search inputs are disabled and we fail fast.

const log = require("../utils/logger");
const { withPage } = require("./browser");
const { ensureLoggedIn } = require("./partslink");
const { openCatalog, dealerSelected, vinInputEnabled, isDemoMode, SEL } = require("./catalog");
const { brandForVin, validateVin } = require("./vin");
const { UpstreamError, ValidationError } = require("../utils/errors");
const { captureFailure } = require("../utils/screenshot");

function normalizePartNumber(raw) {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new ValidationError("partNumber is required");
  }
  return raw.trim();
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
      await openCatalog(page, effectiveBrand);

      if (!(await dealerSelected(page))) {
        const screenshot = await captureFailure(page, `part-no-dealer-${effectiveBrand}`);
        throw new UpstreamError("PartsLink24 catalog requires a dealer to be selected", {
          brand: effectiveBrand, code: "dealer_selection_required", screenshot,
        });
      }

      if (!(await vinInputEnabled(page))) {
        const demo = await isDemoMode(page);
        const screenshot = await captureFailure(page, `part-disabled-${effectiveBrand}`);
        throw new UpstreamError(
          demo
            ? `PartsLink24 '${effectiveBrand}' catalog is in demo mode — part search disabled. Activate the ${effectiveBrand} subscription.`
            : `PartsLink24 search inputs are disabled for brand '${effectiveBrand}' — dealer may not be selected, or the account lacks search entitlement.`,
          { brand: effectiveBrand, code: demo ? "demo_mode" : "inputs_disabled", screenshot },
        );
      }

      // Optional VIN context — narrows the part search to one vehicle.
      if (vin) {
        const valid = validateVin(vin);
        await page.locator(SEL.vinInput).first().fill(valid);
        await page.locator(SEL.vinInput).first().press("Enter");
        await page.waitForTimeout(2000);
      }

      // Now perform the part-number search.
      await page.locator(SEL.partInput).first().fill(partNo);
      await page.locator(SEL.partInput).first().press("Enter");
      await page.waitForTimeout(2500);

      // Extract best-effort result. PartsLink24 renders results in a
      // companion panel; the exact shape varies per brand. We return the
      // raw text + any image src we can find so callers get something
      // actionable even before per-brand extractors exist.
      const result = await page.evaluate(() => {
        const visible = (el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        };
        const companion = document.querySelector('[data-test-id="companion"]');
        const img = Array.from(document.querySelectorAll('img'))
          .filter(visible)
          .filter((i) => i.src && !i.src.endsWith(".svg") && i.naturalWidth > 80)
          .map((i) => i.src)[0] || null;
        const bodyText = (companion?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 1200);
        return { companionText: bodyText, imageUrl: img };
      });

      log.info("partslink.part.lookup.ok", {
        brand: effectiveBrand, partNo, hasImage: !!result.imageUrl,
      });

      return {
        partNumber: partNo,
        brand: effectiveBrand,
        vin: vin ?? null,
        name: null,
        description: result.companionText || null,
        imageUrl: result.imageUrl,
        category: null,
        compatibleVehicles: [],
        meta: {
          resolved: !!result.companionText,
          sessionReused: login.sessionReused,
        },
      };
    } catch (err) {
      if (err.code === "dealer_selection_required") throw err;
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
