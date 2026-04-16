// Part-number lookup against PartsLink24.
//
// We reuse the same entry path that VIN decode uses (the global search on
// /partslink24/startup.do). When a VIN is supplied, entering it routes us
// to the matching brand catalog; within that catalog the partSearchInput
// is enabled on demo accounts (unlike the VIN input which is gated). When
// only a brand is supplied we open the catalog directly.

const config = require("../config");
const log = require("../utils/logger");
const { withPage } = require("./browser");
const { ensureLoggedIn } = require("./partslink");
const { brandForVin, validateVin } = require("./vin");
const { UpstreamError, ValidationError } = require("../utils/errors");
const { captureFailure } = require("../utils/screenshot");

const GLOBAL_VIN_INPUT = 'form[name="search-text"] input[name="text"]';
const PART_INPUT = '[data-test-id="partSearchInput"] input';
const PART_SUBMIT = '[data-test-id="sendPartSearch"]';
const BRAND_BREADCRUMB = '[data-test-id="breadcrumbCatalogName"]';
const CATALOG_URL = (brand) =>
  `${config.partslink24.baseUrl}/partslink24/launchCatalog.do?service=${encodeURIComponent(`${brand}_parts`)}`;

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
      if (vin) {
        const valid = validateVin(vin);
        // Route via the global VIN search — this lands us in the right
        // brand catalog without us having to guess the slug.
        await page.goto(config.partslink24.baseUrl, { waitUntil: "domcontentloaded" });
        await page.waitForSelector(GLOBAL_VIN_INPUT, { timeout: 20_000 });
        await page.locator(GLOBAL_VIN_INPUT).first().fill(valid);
        await Promise.all([
          page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 20_000 }).catch(() => {}),
          page.evaluate(() => { if (typeof searchText === "function") searchText(); }),
        ]);
      } else {
        // No VIN — open the brand catalog directly.
        await page.goto(CATALOG_URL(effectiveBrand), { waitUntil: "domcontentloaded" });
      }

      // Wait for the catalog SPA to hydrate.
      await page.waitForSelector(BRAND_BREADCRUMB, { timeout: 20_000 }).catch(() => {});

      // Dealer-gate: PartsLink24 hides the part-search input until a dealer
      // is selected. The input is present in the DOM but `visibility:hidden`
      // until dealer selection. We detect that state and surface a clear
      // error. Dealer selection is a one-time user action via the web UI
      // (we don't auto-pick one since the wrong dealer affects order flows).
      const partVisible = await page.locator(PART_INPUT).first()
        .isVisible({ timeout: 6000 }).catch(() => false);
      if (!partVisible) {
        const needsDealer = await page.evaluate(() => {
          const byText = Array.from(document.querySelectorAll("button"))
            .some((b) => /select dealer|dealer selecteren/i.test(b.innerText || ""));
          const byTestId = !!document.querySelector('[data-test-id*="Dealer"], [data-test-id*="dealer"]');
          return byText || byTestId;
        }).catch(() => false);
        const screenshot = await captureFailure(page, `part-gated-${effectiveBrand}`);
        const msg = needsDealer
          ? "PartsLink24 requires a dealer to be selected before part search is available. Sign in via the web UI and pick a default dealer once."
          : "Part-search input is hidden — the catalog UI state prevents automated search (dealer/vehicle context missing).";
        throw new UpstreamError(msg, {
          brand: effectiveBrand,
          code: needsDealer ? "dealer_selection_required" : "part_input_hidden",
          screenshot,
        });
      }

      // Dismiss cookie banner if it showed up inside the catalog.
      const cookieBtn = page.locator('#usercentrics-root button[data-testid="uc-accept-all-button"]').first();
      if (await cookieBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
        await cookieBtn.click().catch(() => {});
        await page.waitForTimeout(400);
      }

      // The part search icon (sendPartSearch) is a decorative span, not a
      // clickable button — the real trigger is Enter on the input.
      await page.locator(PART_INPUT).first().fill(partNo);
      await page.locator(PART_INPUT).first().press("Enter");
      await page.waitForTimeout(3000);

      // Best-effort extraction from the result area. Shape varies per brand
      // so we surface the companion panel's text and first non-SVG image.
      const result = await page.evaluate(() => {
        const visible = (el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        };
        const companion = document.querySelector('[data-test-id="companion"]');
        const img = Array.from(document.querySelectorAll("img"))
          .filter(visible)
          .filter((i) => i.src && !i.src.endsWith(".svg") && i.naturalWidth > 80)
          .map((i) => i.src)[0] || null;
        return {
          url: location.href,
          title: document.title,
          brandBreadcrumb: document.querySelector('[data-test-id="breadcrumbCatalogName"]')?.innerText?.trim() || null,
          companionText: (companion?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 1500),
          imageUrl: img,
        };
      });

      log.info("partslink.part.lookup.ok", {
        brand: effectiveBrand, partNo, url: result.url, hasImage: !!result.imageUrl,
      });

      return {
        partNumber: partNo,
        brand: effectiveBrand,
        vin: vin ?? null,
        name: result.brandBreadcrumb,
        description: result.companionText || null,
        imageUrl: result.imageUrl,
        category: null,
        compatibleVehicles: [],
        meta: {
          resolved: !!result.companionText || !!result.imageUrl,
          url: result.url,
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
