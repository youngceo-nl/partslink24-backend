// VIN → vehicle decode against PartsLink24 brand catalogs.
//
// Flow:
//   1. Map VIN WMI → PartsLink24 catalog slug (BMW, Audi, Mercedes, …).
//   2. Ensure we're logged in.
//   3. Launch the brand catalog and wait for the SPA to hydrate.
//   4. If no dealer is selected the search inputs are disabled — surface a
//      helpful `dealer_selection_required` error. Dealer selection is a
//      one-time UI action per account and must happen through the web UI
//      (this service does not automate it to avoid picking a wrong dealer).
//   5. Fill the VIN, submit, wait for the vehicle-context panel to appear,
//      and extract what the breadcrumb / companion panel exposes.
//
// Fields that aren't surfaced for a given brand come back as `null`.

const log = require("../utils/logger");
const { withPage } = require("./browser");
const { ensureLoggedIn } = require("./partslink");
const { openCatalog, dealerSelected, vinInputEnabled, isDemoMode, SEL } = require("./catalog");
const { UpstreamError, ValidationError } = require("../utils/errors");
const { captureFailure } = require("../utils/screenshot");

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
  const brand = explicitBrand ?? brandForVin(vin);
  if (!brand) {
    throw new ValidationError(
      `No PartsLink24 catalog known for VIN WMI "${vin.slice(0, 3)}" — pass an explicit 'brand' (e.g. "audi", "bmw", "mercedes").`,
    );
  }

  const login = await ensureLoggedIn();

  return withPage(async (page) => {
    try {
      await openCatalog(page, brand);

      if (!(await dealerSelected(page))) {
        const screenshot = await captureFailure(page, `vin-no-dealer-${brand}`);
        throw new UpstreamError("PartsLink24 catalog requires a dealer to be selected", {
          brand, code: "dealer_selection_required", screenshot,
        });
      }

      if (!(await vinInputEnabled(page))) {
        const demo = await isDemoMode(page);
        const screenshot = await captureFailure(page, `vin-disabled-${brand}`);
        throw new UpstreamError(
          demo
            ? `PartsLink24 '${brand}' catalog is in demo mode — VIN search disabled. Activate the ${brand} subscription for account ${brand === "mercedes" ? "Mercedes" : brand}.`
            : `PartsLink24 VIN input is disabled for brand '${brand}' — dealer may not be selected, or the account lacks search entitlement.`,
          { brand, code: demo ? "demo_mode" : "vin_input_disabled", screenshot },
        );
      }

      // Fill VIN + submit. The send button is a small icon (<span>) next to
      // the input; pressing Enter on the input also triggers the search.
      await page.locator(SEL.vinInput).first().fill(vin);
      await Promise.race([
        page.locator(SEL.vinInput).first().press("Enter"),
        page.locator(SEL.vinSubmit).first().click({ trial: true }).catch(() => {}),
      ]);
      await page.waitForTimeout(2500);

      // Read whatever breadcrumb / vehicle-summary information is on the page.
      // The shape varies per brand — we dump the breadcrumb + companion text
      // and let the caller decide how to interpret it.
      const meta = await page.evaluate((sel) => {
        const text = (q) => document.querySelector(q)?.innerText?.trim() || null;
        const breadcrumb = text(sel.breadcrumbBrand);
        const companion = text('[data-test-id="companion"]');
        return { breadcrumb, companion };
      }, SEL);

      log.info("partslink.vin.decoded", { vin, brand, meta });
      return {
        vin,
        brand,
        // Brand-specific field extraction isn't wired yet — see README
        // "Known limitations". The raw companion text is returned so callers
        // can parse what PartsLink24 shows in the vehicle panel.
        make: meta.breadcrumb,
        model: null,
        year: null,
        trim: null,
        engine: null,
        meta: {
          resolved: !!meta.companion,
          companion: meta.companion,
          sessionReused: login.sessionReused,
        },
      };
    } catch (err) {
      if (err.code === "dealer_selection_required") throw err;
      const screenshot = await captureFailure(page, `vin-${brand}`);
      log.error("partslink.vin.decode.failed", { vin, brand, message: err.message, screenshot });
      throw new UpstreamError("VIN decode failed", { vin, brand, message: err.message, screenshot });
    }
  });
}

module.exports = { decodeVin, validateVin, brandForVin };
