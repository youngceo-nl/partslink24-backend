// VIN → vehicle decode against PartsLink24.
//
// There are two VIN entry points on the portal:
//   1. GLOBAL search on /partslink24/startup.do (a plain <form name="search-text">)
//      — this is the cross-brand search; the portal routes you to the
//      right catalog. We prefer this because it works even when we can't
//      guess the brand, and it's available in demo accounts.
//   2. Per-brand catalog's `vehicleSearchInput` — only enabled on accounts
//      with an active subscription for that brand. Used as a fallback.
//
// Flow implemented here:
//   1. Ensure we're logged in.
//   2. Navigate to the portal root — the post-login root *is* startup.do,
//      so no deep-link interstitial is triggered.
//   3. Fill the VIN into `form[name="search-text"] input[name="text"]` and
//      invoke the page-provided `searchText()` JS function.
//   4. Wait for the brand catalog to load; extract the breadcrumb +
//      companion panel for vehicle metadata.

const config = require("../config");
const log = require("../utils/logger");
const { withPage } = require("./browser");
const { ensureLoggedIn } = require("./partslink");
const { UpstreamError, ValidationError } = require("../utils/errors");
const { captureFailure } = require("../utils/screenshot");

const GLOBAL_SEARCH = {
  input: 'form[name="search-text"] input[name="text"]',
  submitFn: () => { if (typeof searchText === "function") searchText(); },
};

// Catalog SPA selectors (same across brands, see services/catalog.js).
const CATALOG_SEL = {
  breadcrumbBrand: '[data-test-id="breadcrumbCatalogName"]',
};

const VIN_REGEX = /^[A-HJ-NPR-Z0-9]{17}$/;

// VIN WMI prefix → PartsLink24 catalog slug. Only brands with a confirmed
// `{slug}_parts` service are mapped — others return null so callers can
// pass an explicit `brand`.
const WMI_BRAND = [
  [/^WBA|^WBS/i, "bmw"],
  [/^WAU|^WA1|^WUA/i, "audi"],
  [/^WDD|^WDB|^WDC|^W1K|^W1N/i, "mercedes"],
  [/^WP0|^WP1/i, "porsche"],
  [/^TMB/i, "skoda"],
  [/^VSS/i, "seat"],
  [/^ZFA/i, "fiatp"],
  [/^VF1/i, "renault"],
  [/^VF3/i, "peugeot"],
  [/^VF7/i, "citroen"],
  [/^NLHA|^KMH/i, "hyundai"],
  [/^KNA|^KND/i, "kia"],
  [/^JT|^5T|^2T/i, "toyota"],
  [/^JN|^1N/i, "nissan"],
  [/^YV1/i, "volvo"],
];

function brandForVin(vin) {
  for (const [re, brand] of WMI_BRAND) if (re.test(vin)) return brand;
  return null;
}

function validateVin(vin) {
  if (typeof vin !== "string" || !VIN_REGEX.test(vin.toUpperCase())) {
    throw new ValidationError("Invalid VIN — must be 17 chars (A-Z 0-9, no I/O/Q)");
  }
  return vin.toUpperCase();
}

async function decodeVin(rawVin, { brand: explicitBrand } = {}) {
  const vin = validateVin(rawVin);
  const hintedBrand = explicitBrand ?? brandForVin(vin);

  const login = await ensureLoggedIn();

  return withPage(async (page) => {
    try {
      // Navigate to the authenticated portal root — post-login this resolves
      // to /partslink24/startup.do without triggering the deep-link
      // "Attention" interstitial. Reuse cookies from ensureLoggedIn().
      await page.goto(config.partslink24.baseUrl, { waitUntil: "domcontentloaded" });
      // PartsLink24 shows a "LOADING..." splash post-login for a few seconds
      // before rendering startup.do — wait generously for the VIN form.
      await page.waitForSelector(GLOBAL_SEARCH.input, { timeout: 20_000 });

      // Fill the VIN and trigger the page's own searchText() helper. The
      // form's onsubmit is prevented, so a normal submit won't fire.
      await page.locator(GLOBAL_SEARCH.input).first().fill(vin);
      await Promise.all([
        page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 20_000 }).catch(() => {}),
        page.evaluate(GLOBAL_SEARCH.submitFn),
      ]);
      await page.waitForTimeout(2500);

      // After submit the portal routes us to the matching brand's catalog
      // SPA. Extract the breadcrumb + companion panel for vehicle metadata.
      const meta = await page.evaluate((sel) => {
        const text = (q) => document.querySelector(q)?.innerText?.trim() || null;
        return {
          url: location.href,
          title: document.title,
          breadcrumb: text(sel.breadcrumbBrand),
          companion: text('[data-test-id="companion"]'),
        };
      }, CATALOG_SEL);

      log.info("partslink.vin.decoded", { vin, brand: hintedBrand, meta });
      return {
        vin,
        brand: hintedBrand,
        // Per-brand structured parsers aren't wired yet — we surface the
        // raw breadcrumb + companion text so callers can act on what the UI
        // actually shows.
        make: meta.breadcrumb,
        model: null,
        year: null,
        trim: null,
        engine: null,
        meta: {
          resolved: !!meta.breadcrumb || !!meta.companion,
          url: meta.url,
          title: meta.title,
          companion: meta.companion,
          sessionReused: login.sessionReused,
        },
      };
    } catch (err) {
      const screenshot = await captureFailure(page, `vin-global`);
      log.error("partslink.vin.decode.failed", { vin, message: err.message, screenshot });
      throw new UpstreamError("VIN decode failed", { vin, message: err.message, screenshot });
    }
  });
}

module.exports = { decodeVin, validateVin, brandForVin };
