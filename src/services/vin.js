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
const { withPage, withDeferredPage } = require("./browser");
const { ensureLoggedIn } = require("./partslink");
const { openCatalog, SEL: CATALOG_INPUTS } = require("./catalog");
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

    // Wait for the exploded-view image layers to actually finish loading
    // instead of a blind sleep — any <img> inside the hotspots parent with
    // complete=true and naturalWidth>0 means the layer has rendered.
    await page.waitForFunction(
      () => {
        const parent = document.querySelector(".hotspots-captions-parent");
        if (!parent) return false;
        const imgs = parent.querySelectorAll("img");
        if (imgs.length === 0) return false;
        return Array.from(imgs).every((img) => img.complete && img.naturalWidth > 0);
      },
      undefined,
      { timeout: 5000 },
    ).catch(() => {});

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

// VIN WMI prefix → PartsLink24 catalog slug. Slugs must match the service
// param exposed on /partslink24/launchCatalog.do (see the brand-menu HTML
// for the full list). Prefix patterns follow ISO 3780 WMI assignments.
// First match wins — narrower patterns (e.g. Infiniti's JNK) must come
// before broader ones that would otherwise swallow them (e.g. Nissan's JN).
const WMI_BRAND = [
  // BMW Group
  [/^WBA|^WBS|^WBX|^WBY|^5UX|^5YM|^4US/i, "bmw"],
  [/^WMW/i, "mini"],
  // Mercedes-Benz Group (sedans/coupes first, then vans, then smart).
  [/^WDD|^WDB|^WDC|^W1K|^W1N|^4JG/i, "mercedes"],
  [/^WDF|^W1V|^W1W|^WDY/i, "mercedesvans"],
  [/^WME/i, "smart"],
  // VW Group
  [/^WAU|^WA1|^WUA|^TRU/i, "audi"],
  [/^WVW|^3VW|^1VW|^9BW|^LSV/i, "vw"],
  [/^WV1|^WV2/i, "vn"],
  [/^TMB/i, "skoda"],
  [/^VSS|^VSE/i, "seat"],
  [/^VSZ/i, "cupra"],
  // Porsche
  [/^WP0|^WP1/i, "porsche"],
  // Stellantis — Fiat family
  [/^ZFA/i, "fiatp"],
  [/^ZAR/i, "alfa"],
  [/^ZLA/i, "lancia"],
  // Stellantis — PSA brands
  [/^VF3|^VR3/i, "peugeot"],
  [/^VF7|^VR7/i, "citroen"],
  [/^UU1|^UU5/i, "dacia"],
  [/^VF1|^VF6|^VF8/i, "renault"],
  [/^W0L/i, "opel"],
  [/^W0V/i, "vauxhall"],
  // Ford
  [/^WF0|^WF2/i, "fordp"],
  // Asian brands
  [/^NLHA|^KMH|^KMF|^TMA|^NLH/i, "hyundai"],
  [/^KNA|^KND|^KNC|^U5Y|^U6Y/i, "kia"],
  // Infiniti BEFORE Nissan — JNK would otherwise match JN.
  [/^JNK|^JNR|^JNX|^SJK/i, "infiniti"],
  [/^JN|^1N|^SJN|^VWA/i, "nissan"],
  [/^JT|^5T|^2T|^VNK|^SB1/i, "toyota"],
  [/^JMB|^JMY|^JA3|^JA4/i, "mmc"], // Mitsubishi — PL24 slug is "mmc_parts"
  [/^JS|^TSM|^9M|^KL0/i, "suzuki"],
  // Volvo
  [/^YV1|^YV4/i, "volvo"],
  // Jaguar / Land Rover
  [/^SAJ/i, "jaguar"],
  [/^SAL/i, "landrover"],
  // Jeep (Stellantis)
  [/^1J|^ZAC/i, "jeep"],
  // Bentley / Iveco
  [/^SCB/i, "bentley"],
  [/^ZCF/i, "iveco"],
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
  Verkoopbenaming: "model",          // Mercedes: "C 180 Estate", "GT3 RS GT3-3"
  Motorcode: "engineCode",
  Versnellingcode: "transmissionCode",
  Asaandrijvingskarakteristiek: "axleDrive",
  Uitrusting: "equipment",
  "Kleur van het dak": "roofColor",
  Tapijtkleurcode: "carpetColor",
  "Kleur exterieur / Laknummer": "paintCode",
  Laknummer: "paintCode",             // Mercedes brand-catalog uses bare label
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

// Fallback flow when the global search on /partslink24/startup.do returns
// "VIN not in any catalog". Loads the brand's SPA directly at
// /partslink24/launchCatalog.do?service={brand}_parts (redirects into
// /pl24-app/{brand}_parts/…) and fills the VIN into the catalog's
// "Directe toegang" input ([data-test-id="vehicleSearchInput"]).
//
// Returns one of:
//   "resolved"        — vehicle metadata loaded, caller should extract
//   "brand_not_open"  — account has no subscription / catalog stays in demo
//   "input_disabled"  — dealer context missing, VIN input is disabled
//   "vin_not_found"   — brand catalog also rejected the VIN
//   "timeout"         — neither success nor a clean error within the window
//
// Leaves the page positioned on whichever catalog state it ended on — the
// caller extracts metadata on "resolved" and falls through otherwise.
async function retryViaBrandCatalog(page, vin, brand) {
  try {
    await openCatalog(page, brand);
  } catch (err) {
    log.warn("partslink.vin.brand_catalog_open_failed", { vin, brand, message: err.message });
    return "brand_not_open";
  }

  // VIN input should be present. If missing entirely, the brand isn't
  // accessible on this account (demo mode / no subscription).
  const vinInput = page.locator(CATALOG_INPUTS.vinInput).first();
  const visible = await vinInput.isVisible({ timeout: 5000 }).catch(() => false);
  if (!visible) return "brand_not_open";

  // Disabled = dealer context still missing. Surface as its own state so
  // the caller can show a clearer error message.
  const editable = await vinInput.isEditable({ timeout: 2000 }).catch(() => false);
  if (!editable) return "input_disabled";

  await vinInput.fill(vin);

  // Prefer the explicit submit button; fall back to Enter if the test-id
  // isn't rendered (older catalog builds use a wrapping button).
  const submit = page.locator(CATALOG_INPUTS.vinSubmit).first();
  const hasSubmit = await submit.isVisible({ timeout: 1500 }).catch(() => false);
  if (hasSubmit) await submit.click().catch(() => {});
  else await vinInput.press("Enter").catch(() => {});

  // Race: companion hydrates with our VIN (success), or a catalog-level
  // error toast/inline message shows up (not found on this catalog).
  const outcome = await Promise.race([
    page
      .waitForFunction(
        (v) => {
          const el = document.querySelector('[data-test-id="companion"]');
          return !!el && (el.innerText || "").includes(v);
        },
        vin,
        { timeout: 20_000 },
      )
      .then(() => "resolved"),
    page
      .waitForFunction(
        () => {
          const txt = (document.body?.innerText || "").toLowerCase();
          return (
            txt.includes("geen voertuig") ||
            txt.includes("niet gevonden") ||
            txt.includes("not found") ||
            txt.includes("no vehicle") ||
            txt.includes("kein fahrzeug")
          );
        },
        undefined,
        { timeout: 20_000 },
      )
      .then(() => "vin_not_found"),
  ]).catch(() => "timeout");

  log.info("partslink.vin.brand_catalog_outcome", { vin, brand, outcome });
  return outcome;
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

  return withDeferredPage(async (page, closePage) => {
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

      // Fill the VIN and submit. Don't await navigation separately — on a
      // not-found the portal renders `#search-error` inline without navigating,
      // so a plain waitForNavigation burns the full timeout. Instead, fire
      // the submit and race against whichever outcome appears first.
      await page.locator(GLOBAL_SEARCH.input).first().fill(vin);
      await page.evaluate(GLOBAL_SEARCH.submitFn);

      // Race: inline not-found error, catalog breadcrumb (nav succeeded),
      // or timeout. Bail fast on the error.
      const outcome = await Promise.race([
        page.waitForSelector('#search-error:visible', { timeout: 20_000 })
          .then(() => "not_found"),
        page.waitForSelector(CATALOG_SEL.breadcrumbBrand, { timeout: 20_000 })
          .then(() => "catalog"),
      ]).catch(() => "timeout");

      if (outcome === "not_found") {
        // The global search has a narrower catalog index than individual
        // brand SPAs — e.g. some W1K Mercedes VINs aren't findable here but
        // resolve fine from the brand page's "Directe toegang" input. If we
        // can guess the brand from the WMI, try the brand-catalog fallback.
        if (hintedBrand) {
          log.info("partslink.vin.global_not_found_retry_brand", { vin, brand: hintedBrand });
          const retryOutcome = await retryViaBrandCatalog(page, vin, hintedBrand);
          if (retryOutcome === "resolved") {
            // Success — drop into the shared extract/return path below.
          } else {
            const errText = await page.locator("#search-error").first().innerText()
              .then((s) => s.trim()).catch(() => "VIN not in any catalog");
            throw new UpstreamError("VIN not found in any PartsLink24 catalog", {
              vin, code: "vin_not_in_catalog", portalMessage: errText,
              fallbackTried: hintedBrand, fallbackOutcome: retryOutcome,
            });
          }
        } else {
          const errText = await page.locator("#search-error").first().innerText()
            .then((s) => s.trim()).catch(() => "VIN not in any catalog");
          throw new UpstreamError("VIN not found in any PartsLink24 catalog", {
            vin, code: "vin_not_in_catalog", portalMessage: errText,
          });
        }
      }

      // Wait for the companion panel to hydrate. "Hydrated" = its text
      // contains the VIN we just searched, which is locale-independent.
      // Falls back to the previous 4s safety margin on timeout.
      await page.waitForFunction(
        (vin) => {
          const el = document.querySelector('[data-test-id="companion"]');
          return !!el && (el.innerText || "").includes(vin);
        },
        vin,
        { timeout: 10_000 },
      ).catch(() => {});

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

      // We always return this path. The file is written asynchronously after
      // the decode response — the frontend shows a brand-logo placeholder and
      // swaps in the PartsLink24 image once it 200s from the static mount.
      const imagePath = `/vehicle-images/${vin}.png`;

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

      // Kick off image capture in the background. The page stays open until
      // capture completes; errors are swallowed (imagePath may 404 briefly —
      // the frontend falls back to a brand logo until it succeeds).
      captureVehicleImage(page, vin)
        .catch((err) => log.warn("partslink.vin.bg_image_failed", { vin, message: err.message }))
        .finally(() => closePage());

      return result;
    } catch (err) {
      const screenshot = await captureFailure(page, `vin-global`);
      log.error("partslink.vin.decode.failed", { vin, message: err.message, screenshot });
      await closePage();
      throw new UpstreamError("VIN decode failed", { vin, message: err.message, screenshot });
    }
  });
}

module.exports = { decodeVin, validateVin, brandForVin };
