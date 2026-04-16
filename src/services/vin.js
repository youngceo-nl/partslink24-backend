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

const fs = require("node:fs/promises");
const path = require("node:path");
const config = require("../config");
const log = require("../utils/logger");
const { withPage } = require("./browser");
const { ensureLoggedIn } = require("./partslink");
const { UpstreamError, ValidationError } = require("../utils/errors");
const { captureFailure } = require("../utils/screenshot");

// Screenshots of the Graphical Navigation panel, keyed by VIN. Served as
// static images by server.js so the frontend can <img src=…> them.
const VEHICLE_IMAGES_DIR = path.resolve(process.cwd(), "artifacts", "vehicle-images");

// Capture the Scope-panel assembly (the exploded-view diagram of the car)
// and write it to artifacts/vehicle-images/{vin}.png. Returns a URL path
// like `/vehicle-images/{vin}.png` that the caller can hand to the client
// (the Express server mounts the dir at that path). Never throws — a
// missing image shouldn't break the decode flow.
async function captureVehicleImage(page, vin) {
  try {
    const trigger = page.locator('[aria-label="Graphical Navigation"]').first();
    const hasTrigger = await trigger.isVisible({ timeout: 4000 }).catch(() => false);
    if (!hasTrigger) return null;

    await trigger.click();
    // Give the Scope panel time to render its base64 image layers.
    await page.waitForTimeout(2000);

    // The scope container class ends in a build-hash suffix (…_116af_16 in
    // the current bundle). Match by prefix so it survives bundle rebuilds.
    const scope = page.locator('[class*="_container_"][class*="_16"]').filter({
      has: page.locator(".event-catcher"),
    }).first();
    const scopeVisible = await scope.isVisible({ timeout: 4000 }).catch(() => false);
    if (!scopeVisible) return null;

    await fs.mkdir(VEHICLE_IMAGES_DIR, { recursive: true });
    const file = path.join(VEHICLE_IMAGES_DIR, `${vin}.png`);
    await scope.screenshot({ path: file, omitBackground: false });
    log.info("partslink.vin.image_captured", { vin, file });
    return `/vehicle-images/${vin}.png`;
  } catch (err) {
    log.warn("partslink.vin.image_capture_failed", { vin, message: err.message });
    return null;
  }
}

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

// Extract structured fields from the catalog companion panel. The text is a
// list of alternating label/value lines. Labels we know about get mapped
// into camelCase fields; unknown labels are ignored. Anything we can't
// confidently parse stays null so the caller can fall back on `companion`
// (raw text).
const COMPANION_LABELS = {
  Model: "model",
  "Date of production": "productionDate",
  Year: "year",
  "Sales type": "salesType",
  "Engine Code": "engineCode",
  "Transmission Code": "transmissionCode",
  "Axle drive": "axleDrive",
  Equipment: "equipment",
  "Roof color": "roofColor",
  "Carpet color code": "carpetColor",
  "Exterior color / Paint Code": "paintCode",
  "Seat combination no.": "seatCombination",
  "Number of Z-Orders": "zOrderCount",
  "PR no.": "prNumber",
};

function parseCompanion(text) {
  if (!text || typeof text !== "string") return {};
  const lines = text.split(/\n+/).map((s) => s.trim()).filter(Boolean);
  const out = {};
  for (let i = 0; i < lines.length - 1; i++) {
    const field = COMPANION_LABELS[lines[i]];
    if (!field) continue;
    const raw = lines[i + 1];
    out[field] = field === "year" ? parseYear(raw) : raw;
  }
  return out;
}

function parseYear(raw) {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 1900 && n <= 2100 ? n : null;
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

      const parsed = parseCompanion(meta.companion);

      // Capture the exploded-view diagram from Graphical Navigation. Best
      // effort — if the element isn't there (catalog still loading, or
      // this brand doesn't expose one) we simply return null.
      const imagePath = await captureVehicleImage(page, vin);

      log.info("partslink.vin.decoded", { vin, brand: hintedBrand, parsed, imagePath });
      return {
        vin,
        brand: hintedBrand,
        make: meta.breadcrumb,
        model: parsed.model ?? null,
        year: parsed.year ?? null,
        // PartsLink24 doesn't expose a separate "trim" label — the model
        // string itself carries it (e.g. "GT3 RS GT3-3"). Leave null so the
        // frontend can decide whether to derive it from `model`.
        trim: null,
        engine: parsed.engineCode ?? null,
        // Rich OEM-catalog fields only available from PartsLink24.
        productionDate: parsed.productionDate ?? null,
        salesType: parsed.salesType ?? null,
        engineCode: parsed.engineCode ?? null,
        transmissionCode: parsed.transmissionCode ?? null,
        axleDrive: parsed.axleDrive ?? null,
        equipment: parsed.equipment ?? null,
        paintCode: parsed.paintCode ?? null,
        roofColor: parsed.roofColor ?? null,
        carpetColor: parsed.carpetColor ?? null,
        seatCombination: parsed.seatCombination ?? null,
        vehicleImageUrl: imagePath,
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
