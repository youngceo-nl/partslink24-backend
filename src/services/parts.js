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
const { openCatalog, SEL: CATALOG_SEL } = require("./catalog");
const { UpstreamError, ValidationError } = require("../utils/errors");
const { captureFailure } = require("../utils/screenshot");

// Re-export the shared selector so the placeholder fallback in catalog.js
// flows through this module. Previously we had a stricter local copy that
// broke when PL24 stopped setting data-test-id on the parent of the
// "Onderdelen zoeken" input.
const PART_INPUT = CATALOG_SEL.partInput;
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

// Parse an AVP price string from the Artikel-informatie panel into cents.
// PartsLink24 uses Dutch formatting on a localised portal:
//   "€ 4,76"           → 476       (comma decimal)
//   "€ 1.098,99"       → 109899    (dot thousands, comma decimal)
//   "€ 1.200"          → 120000    (no decimals)
//   "EUR 4.76"         → 476       (US fallback, shouldn't happen on PL24 NL)
// Returns null when no numeric value can be extracted.
function parseEurPrice(raw) {
  if (typeof raw !== "string") return null;
  const cleaned = raw.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
  const numMatch = cleaned.match(/(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{1,2})?|\d+[.,]\d{1,2}|\d+)/);
  if (!numMatch) return null;
  let num = numMatch[1];
  const lastDot = num.lastIndexOf(".");
  const lastComma = num.lastIndexOf(",");
  let decimalSep = null;
  if (lastDot >= 0 && lastComma >= 0) {
    decimalSep = lastDot > lastComma ? "." : ",";
  } else if (lastComma >= 0 && /,\d{1,2}$/.test(num)) {
    decimalSep = ",";
  } else if (lastDot >= 0 && /\.\d{1,2}$/.test(num) && !/\.\d{3}$/.test(num)) {
    decimalSep = ".";
  }
  if (decimalSep === ",") num = num.replace(/\./g, "").replace(",", ".");
  else if (decimalSep === ".") num = num.replace(/,/g, "");
  else num = num.replace(/[.,]/g, "");
  const n = parseFloat(num);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
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
      // Step 1 — land inside the brand catalog with vehicle context.
      //
      // When we have a VIN, open the brand SPA directly (skip the global
      // /startup.do search — its index is narrower, e.g. current-gen
      // Mercedes W1K* VINs fail there), then fill the VIN into the
      // catalog's "Directe toegang" input. That's the same path that the
      // VIN decode uses successfully in services/vin.js, and it leaves
      // the catalog in "vehicle selected" mode so the part-search input
      // becomes available.
      if (vin) {
        const valid = validateVin(vin);
        await openCatalog(page, effectiveBrand);

        // If the session expired we get redirected to /user/login.do.
        if (/\/login\.do|\/loginForward\.do/.test(page.url())) {
          log.warn("partslink.part.session_stale", { partNo, brand: effectiveBrand, url: page.url() });
          await ensureLoggedIn({ force: true });
          await openCatalog(page, effectiveBrand);
        }

        const vinInput = page.locator(CATALOG_SEL.vinInput).first();
        const vinVisible = await vinInput.isVisible({ timeout: 6000 }).catch(() => false);
        if (!vinVisible) {
          const screenshot = await captureFailure(page, `part-no-vin-input-${effectiveBrand}`);
          throw new UpstreamError(
            `PartsLink24 brand catalog (${effectiveBrand}) is not accessible on this account — VIN input not visible.`,
            { brand: effectiveBrand, code: "brand_not_open", screenshot },
          );
        }
        const editable = await vinInput.isEditable({ timeout: 2000 }).catch(() => false);
        if (!editable) {
          const screenshot = await captureFailure(page, `part-vin-disabled-${effectiveBrand}`);
          throw new UpstreamError(
            "PartsLink24 VIN input is disabled — dealer selection required before part search is available.",
            { brand: effectiveBrand, code: "dealer_selection_required", screenshot },
          );
        }

        await vinInput.fill(valid);
        const vinSubmit = page.locator(CATALOG_SEL.vinSubmit).first();
        if (await vinSubmit.isVisible({ timeout: 1500 }).catch(() => false)) {
          await vinSubmit.click().catch(() => {});
        } else {
          await vinInput.press("Enter").catch(() => {});
        }

        // Wait for the vehicle context to lock in — companion panel text
        // must contain the VIN we just searched.
        const loaded = await page
          .waitForFunction(
            (v) => {
              const el = document.querySelector('[data-test-id="companion"]');
              return !!el && (el.innerText || "").includes(v);
            },
            valid,
            { timeout: 25_000 },
          )
          .then(() => true)
          .catch(() => false);
        if (!loaded) {
          const screenshot = await captureFailure(page, `part-vin-context-${effectiveBrand}`);
          throw new UpstreamError(
            `PartsLink24 brand catalog did not load vehicle context for VIN ${valid}.`,
            { brand: effectiveBrand, code: "vin_context_timeout", screenshot },
          );
        }
      } else {
        await page.goto(CATALOG_URL(effectiveBrand), { waitUntil: "domcontentloaded" });
      }

      // Step 2 — wait for catalog SPA to hydrate.
      await page.waitForSelector(BRAND_BREADCRUMB, { timeout: 20_000 }).catch(() => {});

      // Step 3 — wait for the part-search input to hydrate. After a VIN
      // load the catalog continues fetching the groups tree before the
      // part-search toolbar appears; 6s was too tight for slower vehicles
      // (Mercedes post-VIN takes up to ~15s). Race against the dealer-gate
      // button so we fail fast on that specific condition.
      const partReady = await Promise.race([
        page.locator(PART_INPUT).first()
          .waitFor({ state: "visible", timeout: 25_000 })
          .then(() => "visible"),
        page.waitForFunction(
          () => Array.from(document.querySelectorAll("button"))
            .some((b) => /select dealer|dealer selecteren/i.test(b.innerText || "")
              && getComputedStyle(b).display !== "none"
              && (b.offsetWidth > 0 || b.offsetHeight > 0))
            && !document.querySelector('[data-test-id="partSearchInput"] input, input[placeholder="Onderdelen zoeken"]'),
          undefined,
          { timeout: 25_000 },
        ).then(() => "dealer_gate"),
      ]).catch(() => "timeout");

      if (partReady !== "visible") {
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
      // Wait for the search result rows to render. The catalog's default
      // tree view ALSO uses [data-test-id="row"] (one per main group), so
      // a plain row wait would short-circuit before the /search?q=... route
      // even loads. Wait specifically for:
      //   (a) the URL to contain /search?q={oem} (SPA routing done), AND
      //   (b) at least one row that carries a descriptionValue cell
      //       (search-result specific).
      const encodedPartNo = encodeURIComponent(partNo);
      await page.waitForFunction(
        (encoded) => location.href.includes(`/search?q=${encoded}`),
        encodedPartNo,
        { timeout: 15_000 },
      ).catch(() => {});
      await page.waitForFunction(
        () => {
          const rows = document.querySelectorAll('[data-test-id="row"]');
          return Array.from(rows).some(
            (r) => r.querySelector('[data-test-id="descriptionValue"]'),
          );
        },
        undefined,
        { timeout: 15_000 },
      ).catch(() => {});

      // Step 5 — parse result rows. The current Mercedes catalog uses:
      //   descriptionValue — human-readable part name ("ANTENNE (Dakframe achter)")
      //   mgValue          — main group, already prefixed with code ("82 Elektrische installatie")
      //   sgValue          — subgroup ("346 Antenne, antenneversterker en kabelsets")
      // Older catalogs (still live on other brands) also expose:
      //   partnoValue, nameValue, btnrValue
      // We support both and prefer the new shape when present.
      const results = await page.evaluate((searchQuery) => {
        const text = (el) => (el?.innerText || "").replace(/\s+/g, " ").trim();
        // Extract the VALUE for a labeled cell: walk past the "Aanduiding" /
        // "Hoofdgroep" / "Subgroep" label div, return the last inner span's
        // text (that's where the value sits). If no spans exist, strip the
        // label from the combined text.
        const valueIn = (el) => {
          if (!el) return null;
          const spans = el.querySelectorAll("span");
          if (spans.length > 0) {
            const last = spans[spans.length - 1];
            const v = text(last);
            if (v) return v;
          }
          const full = text(el);
          return full.replace(/^(Aanduiding|Hoofdgroep|Subgroep|Aanduid\.|Benaming)\s*/i, "") || null;
        };
        const pick = (row, testId) => valueIn(row.querySelector(`[data-test-id="${testId}"]`));

        const rows = Array.from(document.querySelectorAll('[data-test-id="row"]'))
          .map((row) => {
            const description = pick(row, "descriptionValue") ?? pick(row, "nameValue");
            const mg = pick(row, "mgValue");
            const sg = pick(row, "sgValue");
            const partNoRaw = pick(row, "partnoValue");
            const illustration = pick(row, "btnrValue");
            return {
              partNo: partNoRaw || searchQuery, // Mercedes rows drop the OEM cell; fall back to our query.
              description,
              mg,
              sg,
              illustration,
            };
          })
          .filter((r) => r.description || r.mg || r.sg);

        return { rows };
      }, partNo);

      const first = results.rows[0] || null;
      // mgValue already contains the code + label ("82 Elektrische installatie"),
      // so we can use it directly as the `category` field without a lookup map.
      const mainGroup = first?.mg ?? null;
      const mgNumber = first?.mg?.match(/^(\d+)/)?.[1] ?? null;
      const sgNumber = first?.sg?.match(/^(\d+)/)?.[1] ?? null;

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

      // Step 8 — pull the AVP ("aanbevolen verkoopprijs") from the
      // Artikel-informatie panel. That's the only place Mercedes exposes a
      // retail price inside the catalog. Needed so the price step can fall
      // back on the PL24 list price when Onderdelenlijn has no listings.
      //
      // Flow: after the first row is selected the right-hand detail panel
      // shows one or more rows with `data-test-id="iconValueValue"` —
      // inside lives `[aria-label="Artikel-informatie"]` / `.icon--inform-arrow`.
      // Click the first one that matches our part number (otherwise the
      // first visible), wait for a row with `[data-test-id="priceValue"]`
      // to appear, read the value, parse "€ X,XX" into cents.
      let priceCents = null;
      let priceCurrency = null;
      if (first) {
        try {
          const clicked = await page.evaluate((queryPartNo) => {
            const norm = (s) => (s || "").replace(/\s+/g, "").toUpperCase();
            const wanted = norm(queryPartNo);
            const rows = Array.from(document.querySelectorAll('[data-test-id="row"]'));
            // Prefer the row whose partnoValue matches our OEM.
            const matchRow = rows.find((r) => {
              const cell = r.querySelector('[data-test-id="partnoValue"]');
              return cell && norm(cell.innerText).includes(wanted);
            });
            const pick = matchRow || rows.find((r) => r.querySelector('[aria-label="Artikel-informatie"], .icon--inform-arrow'));
            const icon = pick?.querySelector('[aria-label="Artikel-informatie"], .icon--inform-arrow');
            if (!icon) return false;
            icon.click();
            return true;
          }, partNo);
          if (clicked) {
            // Wait up to 10s for a row with a priceValue cell to appear
            // (SPA fetches the item info async). If it never shows, silently
            // skip — the caller degrades to "no PL24 price".
            const priceText = await page
              .waitForFunction(
                () => {
                  const rows = Array.from(document.querySelectorAll('[data-test-id="row"]'));
                  for (const r of rows) {
                    const cell = r.querySelector('[data-test-id="priceValue"]');
                    if (!cell) continue;
                    const raw = (cell.innerText || "").replace(/\s+/g, " ").trim();
                    if (raw) return raw;
                  }
                  return null;
                },
                undefined,
                { timeout: 10_000, polling: 300 },
              )
              .then((h) => h.jsonValue())
              .catch(() => null);
            if (typeof priceText === "string" && priceText) {
              const parsed = parseEurPrice(priceText);
              if (parsed != null) {
                priceCents = parsed;
                priceCurrency = "EUR";
                log.info("partslink.part.price_captured", { brand: effectiveBrand, partNo, priceCents, rawPriceText: priceText });
              }
            }
            if (priceCents == null) {
              log.warn("partslink.part.price_missing", { brand: effectiveBrand, partNo });
            }
          }
        } catch (err) {
          log.warn("partslink.part.price_capture_failed", { brand: effectiveBrand, partNo, message: err.message });
        }
      }

      log.info("partslink.part.lookup.ok", {
        brand: effectiveBrand, partNo, resultCount: results.rows.length, partImageUrl, priceCents,
      });

      return {
        partNumber: partNo,
        brand: effectiveBrand,
        vin: vin ?? null,
        name: first?.description ?? null,
        description: first?.description ?? null,
        imageUrl: partImageUrl,
        // PartsLink24 AVP (aanbevolen verkoopprijs) — the retail list price
        // for this OEM on the brand catalog. Null when we couldn't open the
        // Artikel-informatie panel or the catalog doesn't expose a price.
        priceCents,
        priceCurrency,
        category: mainGroup,
        // mg/sgNumber extract just the leading digits ("82", "346") so callers
        // can key off the code alone; mg/sg below keep the full "82 Elektrische
        // installatie" string for display.
        mainGroupNumber: mgNumber,
        subGroupNumber: sgNumber,
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
