// PartsLink24 session + navigation helpers.
//
// Login flow (discovered via scripts/probe-login.js):
//   GET  /partslink24/user/login.do   → login form
//   POST /partslink24/user/login.do   with accountLogin, userLogin, loginBean.password
//   After success the page redirects to the authenticated portal; we detect
//   this by checking the URL path + absence of the login form.
//
// VIN + part lookup are brand-specific catalog apps that launch via
//   /partslink24/launchCatalog.do?service={brand}_parts
// so we can't implement a single universal flow here — those live in
// services/vin.js and services/parts.js.

const fs = require("node:fs/promises");
const config = require("../config");
const log = require("../utils/logger");
const { withPage, saveStorageState, clearStorageState } = require("./browser");
const { UpstreamError } = require("../utils/errors");
const { captureFailure } = require("../utils/screenshot");

const LOGIN_PATH = "/partslink24/user/login.do";
const LOGIN_URL = () => `${config.partslink24.baseUrl}${LOGIN_PATH}`;

// Selectors — verified against the live form on 2026-04-16.
const SEL = {
  companyId: 'input[name="accountLogin"]',
  username: 'input[name="userLogin"]',
  password: 'input[name="loginBean.password"]',
  submit: "#hidden-login",
  loginForm: 'form[name="loginForm"]',
  errorBanner: ".errorMessage, .error-message, .login-error",
};

/**
 * Detect post-login state. We treat the visible company-ID input as the
 * authoritative "logged out" signal — the portal redirects unauth requests
 * to /login.do so the safe default when we can't read the page is "logged
 * out" (force a fresh login rather than paper over an expired session).
 */
async function isLoggedIn(page) {
  const onLoginPath = page.url().includes(LOGIN_PATH);
  if (!onLoginPath) return true;
  const inputVisible = await page
    .locator(SEL.companyId)
    .first()
    .isVisible({ timeout: 3000 })
    .catch(() => true); // on error, assume form is there → logged out
  return !inputVisible;
}

async function hasSessionFile() {
  try {
    const s = await fs.stat(config.paths.sessionFile);
    return s.isFile() && s.size > 0;
  } catch {
    return false;
  }
}

/**
 * Ensure the current context is authenticated. Returns whether a fresh login
 * happened (vs. the existing session being reused).
 */
async function ensureLoggedIn({ force = false } = {}) {
  // Only attempt "reuse" if a storage-state file exists — otherwise the
  // browser has no cookies and the reuse check costs a redundant navigation.
  const sessionExists = await hasSessionFile();

  return withPage(async (page) => {
    // Always enter via the root domain — PartsLink24 serves an interstitial
    // ("Attention — please read carefully") when you deep-link to /login.do
    // directly, and the real form isn't rendered on that page.
    await page.goto(config.partslink24.baseUrl, { waitUntil: "domcontentloaded" });

    if (!force && sessionExists && (await isLoggedIn(page))) {
      log.info("partslink.login.reused", { url: page.url() });
      return { loggedIn: true, sessionReused: true };
    }

    // Root redirects unauth users to the login page; wait for the form to
    // render before filling.
    await page.waitForSelector(SEL.companyId, { timeout: config.browser.actionTimeoutMs });

    log.info("partslink.login.submitting");
    await page.fill(SEL.companyId, config.partslink24.companyId);
    await page.fill(SEL.username, config.partslink24.username);
    await page.fill(SEL.password, config.partslink24.accessCode);

    await Promise.all([
      page.waitForLoadState("domcontentloaded"),
      page.click(SEL.submit).catch(async () => {
        // Fallback — the hidden-login submit is 1×1 px. Trigger form submit.
        await page.evaluate(() => document.forms["loginForm"]?.submit());
      }),
    ]);

    // Wait for either redirect to portal or an error banner.
    await page.waitForTimeout(1500);

    if (!(await isLoggedIn(page))) {
      const errText = await page.locator(SEL.errorBanner).first().innerText().catch(() => null);
      const screenshot = await captureFailure(page, "login-failed");
      log.error("partslink.login.failed", { errText, screenshot, url: page.url() });
      throw new UpstreamError("PartsLink24 login failed", {
        url: page.url(),
        message: errText ?? "unknown",
        screenshot,
      });
    }

    await saveStorageState();
    log.info("partslink.login.success", { url: page.url() });
    return { loggedIn: true, sessionReused: false };
  });
}

/** Test-only: force a logout next call. */
async function invalidateSession() {
  await clearStorageState();
}

/** Return a stable status blob for /health. */
async function sessionStatus() {
  let hasSessionFile = false;
  try {
    const s = await fs.stat(config.paths.sessionFile);
    hasSessionFile = s.isFile() && s.size > 0;
  } catch { /* no file */ }
  return { hasSessionFile };
}

module.exports = {
  ensureLoggedIn,
  invalidateSession,
  sessionStatus,
  LOGIN_PATH,
};
