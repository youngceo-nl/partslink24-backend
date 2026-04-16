// Catalog-app helpers. PartsLink24 redirects a launched brand catalog into
// a React app served at /pl24-app/{brand}_parts/... The UI is the same
// across brands (same React bundle) so we can share selectors.
//
// Selectors (data-test-id attributes, discovered 2026-04-16):
//   vehicleSearchInput   — 17-char VIN input; placeholder "Directe toegang".
//                          Disabled until a dealer is selected.
//   sendVehicleSearch    — icon button to submit the VIN.
//   partSearchInput      — free-text part search; placeholder "Onderdelen zoeken".
//   sendPartSearch       — icon button to submit the part search.
//   noDealerSelectedButton — only shown when no dealer is chosen. If this
//                            is visible the search inputs are disabled.
//   breadcrumbCatalogName — the brand name, populated after catalog load.

const config = require("../config");

const CATALOG_URL = (brand) =>
  `${config.partslink24.baseUrl}/partslink24/launchCatalog.do?service=${encodeURIComponent(
    `${brand}_parts`,
  )}`;

const SEL = {
  vinInput: '[data-test-id="vehicleSearchInput"] input',
  vinSubmit: '[data-test-id="sendVehicleSearch"]',
  partInput: '[data-test-id="partSearchInput"] input',
  partSubmit: '[data-test-id="sendPartSearch"]',
  noDealerBtn: '[data-test-id="noDealerSelectedButton"]',
  breadcrumbBrand: '[data-test-id="breadcrumbCatalogName"]',
  // Usercentrics cookie consent — the "Accept all" button text is localized.
  // We fall back to the data-testid that Usercentrics uses across languages.
  cookieAcceptAll: '#usercentrics-root button[data-testid="uc-accept-all-button"]',
  cookieAcceptAllByText: '#usercentrics-root button:has-text("Alles accepteren"), #usercentrics-root button:has-text("Accept all")',
};

async function dismissCookieBanner(page) {
  // Prefer Usercentrics' JS API — works even when the accept button
  // renders outside the viewport, which happens on wider screens.
  await page.evaluate(() => {
    const ui = window.UC_UI;
    if (ui?.acceptAllConsents) ui.acceptAllConsents().catch(() => {});
    else if (ui?.closeCMP) ui.closeCMP();
  }).catch(() => {});
  await page.waitForTimeout(300);

  // Fallback: force-click the accept button by its stable test-id.
  for (const sel of [SEL.cookieAcceptAll, SEL.cookieAcceptAllByText]) {
    const btn = page.locator(sel).first();
    if ((await btn.count()) > 0) {
      await btn.click({ force: true, timeout: 2000 }).catch(() => {});
      await page.waitForTimeout(300);
      return true;
    }
  }
  return false;
}

async function openCatalog(page, brand) {
  await page.goto(CATALOG_URL(brand), { waitUntil: "domcontentloaded", timeout: config.browser.navTimeoutMs });
  // Wait for the SPA to mount — the breadcrumb only appears once the bundle
  // has hydrated, which is a reliable "ready" signal.
  await page.waitForSelector(SEL.breadcrumbBrand, { timeout: config.browser.actionTimeoutMs })
    .catch(() => {});
  await dismissCookieBanner(page);
  await page.waitForTimeout(1000);
}

/**
 * Detects whether the catalog is in "demo" mode — the PartsLink24 UI renders
 * a repeating "demo" watermark across every page when the account doesn't
 * have an active subscription for the brand, AND the VIN/part inputs are
 * disabled. If we don't surface this explicitly the scraper just times out
 * on the disabled input and returns a cryptic error.
 */
async function isDemoMode(page) {
  return page.evaluate(() => {
    // Heuristic: the demo watermark is drawn by repeated span/text elements
    // whose visible text is "demo" (lowercase). It's also embedded in CSS as
    // a background-image on a wrapping container. We match the text form.
    const text = (document.body?.innerText || "").toLowerCase();
    if (!text.includes("demo")) return false;
    const demoHits = (text.match(/\bdemo\b/g) || []).length;
    return demoHits >= 6;
  }).catch(() => false);
}

/** Returns true if the VIN input accepts user input (i.e. not disabled). */
async function vinInputEnabled(page) {
  return page.locator(SEL.vinInput).first()
    .isEditable({ timeout: 2000 }).catch(() => false);
}

/**
 * Returns `true` when a dealer has been selected (search inputs enabled).
 * If no dealer is set the catalog surfaces a "Dealer selecteren" button.
 */
async function dealerSelected(page) {
  const btnVisible = await page.locator(SEL.noDealerBtn).first()
    .isVisible({ timeout: 2000 }).catch(() => false);
  return !btnVisible;
}

module.exports = {
  CATALOG_URL, SEL, openCatalog, dealerSelected, isDemoMode, vinInputEnabled,
};
