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
    // The vehicle image lives inside .hotspots-captions-parent. If it's
    // not visible yet, click the "Grafische navigatie" toggle to open it.
    const alreadyOpen = await page
      .locator(".hotspots-captions-parent").first()
      .isVisible({ timeout: 1500 }).catch(() => false);

    if (!alreadyOpen) {
      // The trigger button uses aria-label "Grafische navigatie" (Dutch)
      // or has the icon--images class inside a _headerIconEmphasized_ div.
      const trigger = page.locator(
        '[aria-label="Grafische navigatie"], ' +
        '[aria-label="Graphical Navigation"], ' +
        '._headerIconEmphasized_zjkrf_198 .icon--images, ' +
        '[class*="_headerIconEmphasized_"] .icon--images',
      ).first();
      const hasTrigger = await trigger.isVisible({ timeout: 4000 }).catch(() => false);
      if (!hasTrigger) {
        log.warn("partslink.vin.image_capture.no_trigger", { vin, url: page.url() });
        return null;
      }
      await trigger.click();
      // Wait for the hotspots panel to render after clicking.
      await page.locator(".hotspots-captions-parent").first()
        .waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
    }

    // Give the panel time to fully render its image layers.
    await page.waitForTimeout(2000);

    // Screenshot the .hotspots-captions-parent element which contains
    // the exploded-view diagram of the vehicle.
    const el = page.locator(".hotspots-captions-parent").first();
    const isVisible = await el.isVisible().catch(() => false);
    if (!isVisible) {
      log.warn("partslink.vin.image_capture.panel_not_visible", { vin });
      return null;
    }

    await fs.mkdir(VEHICLE_IMAGES_DIR, { recursive: true });
    const file = path.join(VEHICLE_IMAGES_DIR, `${vin}.png`);
    await el.screenshot({ path: file });
    const stat = await fs.stat(file);
    log.info("partslink.vin.image_captured", { vin, file, bytes: stat.size });
    return `/vehicle-images/${vin}.png`;
  } catch (err) {
    log.warn("partslink.vin.image_capture_failed", { vin, message: err.message });
    return null;
  }
}

const STARTUP_URL = () => `${config.partslink24.baseUrl}/partslink24/startup.do`;

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
// PartsLink24 companion labels → field mapping. The portal can render
// in English, Dutch, or German depending on account locale, so we map
// all known variants for each field.
const COMPANION_LABELS = {
  // English
  Model: "model",
  "Date of production": "productionDate",
  Year: "year",
  "Model year": "year",
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
  // Dutch
  Productiedatum: "productionDate",
  Modeljaar: "year",
  Verkooptype: "salesType",
  Motorcode: "engineCode",
  Versnellingcode: "transmissionCode",
  Asaandrijvingskarakteristiek: "axleDrive",
  Uitrusting: "equipment",
  "Kleur van het dak": "roofColor",
  Tapijtkleurcode: "carpetColor",
  "Kleur exterieur / Laknummer": "paintCode",
  "Stoelcombinatie nr.": "seatCombination",
  "Aantal Z-opdrachten": "zOrderCount",
  "PR nr.": "prNumber",
  Chassisnummer: "_skip",
  Voertuigidentificatie: "_skip",
  Voertuiggegevens: "_skip",
  "Voertuig Opties": "_skip",
  "QR-code": "_skip",
  // German
  Produktionsdatum: "productionDate",
  Modelljahr: "year",
  Verkaufstyp: "salesType",
  Motorkennung: "engineCode",
  Getriebeschlüssel: "transmissionCode",
  Achsantriebscharakteristik: "axleDrive",
  Ausstattung: "equipment",
  Dachfarbe: "roofColor",
  Teppichfarbcode: "carpetColor",
  "Aussenfarbe / Lacknummer": "paintCode",
  "Sitzkombination Nr.": "seatCombination",
};

function parseCompanion(text) {
  if (!text || typeof text !== "string") return {};
  const lines = text
    .split(/\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    // Drop disclaimer lines that sometimes appear between labels
    .filter((s) => !s.startsWith("De FI-resultaten"));
  const out = {};
  for (let i = 0; i < lines.length - 1; i++) {
    const field = COMPANION_LABELS[lines[i]];
    if (!field || field === "_skip") continue;
    const raw = lines[i + 1];
    // Don't consume next line if it's itself a known label
    if (COMPANION_LABELS[raw] !== undefined) continue;
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

// In-memory cache of decoded VINs. Each decode costs ~10-15s (Playwright
// navigation + PartsLink24's LOADING splash + graphical-nav capture), so
// caching the results makes repeat lookups instant. VIN→vehicle data is
// effectively immutable for the life of a vehicle, but we TTL the cache
// so stale data from a broken catalog page eventually retries.
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const decodeCache = new Map();

function cacheGet(vin) {
  const e = decodeCache.get(vin);
  if (!e) return null;
  if (Date.now() - e.at > CACHE_TTL_MS) {
    decodeCache.delete(vin);
    return null;
  }
  return e.result;
}

function cacheSet(vin, result) {
  decodeCache.set(vin, { at: Date.now(), result });
}

async function decodeVin(rawVin, { brand: explicitBrand, refresh = false } = {}) {
  const vin = validateVin(rawVin);
  const hintedBrand = explicitBrand ?? brandForVin(vin);

  if (!refresh) {
    const cached = cacheGet(vin);
    if (cached) {
      log.info("partslink.vin.cache_hit", { vin });
      return { ...cached, meta: { ...(cached.meta ?? {}), cached: true } };
    }
  }

  return withPage(async (page) => {
    try {
      // Go straight to startup.do — the browser context shares cookies,
      // so if we're already logged in the VIN search form renders
      // immediately without a separate login round-trip.
      await page.goto(STARTUP_URL(), { waitUntil: "domcontentloaded" });

      // Race: either the VIN search form appears (logged in) or the
      // login form appears (not logged in). Whichever wins, we act
      // immediately — no wasted timeout.
      const winner = await Promise.race([
        page.waitForSelector(GLOBAL_SEARCH.input, { timeout: 15000 })
          .then(() => "search"),
        page.waitForSelector('form[name="loginForm"]', { timeout: 15000 })
          .then(() => "login"),
      ]).catch(() => "timeout");

      let formEl;
      if (winner !== "search") {
        log.info("partslink.vin.needs_login", { vin, reason: winner });
        await ensureLoggedIn();
        await page.goto(STARTUP_URL(), { waitUntil: "domcontentloaded" });
        formEl = await page.waitForSelector(GLOBAL_SEARCH.input, { timeout: 20_000 });
      }

      // Fill the VIN immediately and submit.
      await page.locator(GLOBAL_SEARCH.input).first().fill(vin);
      await Promise.all([
        page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 20_000 }).catch(() => {}),
        page.evaluate(GLOBAL_SEARCH.submitFn),
      ]);
      // Give the SPA time to fully render the catalog after navigation.
      // Some brands (Audi, Porsche) need extra time for the React-based
      // companion panel to hydrate.
      await page.waitForTimeout(4000);

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
      const result = {
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
          sessionReused: false,
        },
      };
      // Only cache successful decodes (resolved == true) so we retry
      // transient failures on the next call.
      if (result.meta.resolved) cacheSet(vin, result);
      return result;
    } catch (err) {
      const screenshot = await captureFailure(page, `vin-global`);
      log.error("partslink.vin.decode.failed", { vin, message: err.message, screenshot });
      throw new UpstreamError("VIN decode failed", { vin, message: err.message, screenshot });
    }
  });
}

module.exports = { decodeVin, validateVin, brandForVin };
