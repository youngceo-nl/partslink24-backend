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

// Circuit breaker: PartsLink24 locks the account after repeated failed
// logins. If a login just failed with "credentials invalid" we cool off
// before attempting another one — otherwise every incoming request would
// trigger another login attempt and extend the lockout.
const LOGIN_COOLDOWN_MS = 15 * 60 * 1000; // 15 minutes
let lastLoginFailureAt = 0;
let lastLoginFailureMessage = null;

function loginOnCooldown() {
  return Date.now() - lastLoginFailureAt < LOGIN_COOLDOWN_MS;
}
function loginCooldownRemainingMs() {
  return Math.max(0, LOGIN_COOLDOWN_MS - (Date.now() - lastLoginFailureAt));
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

    // Circuit breaker — only check once we've confirmed the saved session
    // isn't viable. Otherwise reuse would always work during cooldown.
    if (loginOnCooldown()) {
      const mins = Math.ceil(loginCooldownRemainingMs() / 60_000);
      throw new UpstreamError(
        `PartsLink24 login is on cooldown after a recent failure (${mins} min left). ` +
        `Last error: ${lastLoginFailureMessage ?? "unknown"}`,
        { code: "login_cooldown", minutesRemaining: mins },
      );
    }

    // Root redirects unauth users to the login page; wait for the form to
    // render before filling.
    await page.waitForSelector(SEL.companyId, { timeout: config.browser.actionTimeoutMs });

    // Usercentrics cookie overlay intercepts pointer events on the login
    // inputs — dismiss it first.
    const cookieBtn = page.locator('#usercentrics-root button[data-testid="uc-accept-all-button"]').first();
    if (await cookieBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
      await cookieBtn.click().catch(() => {});
      await page.waitForTimeout(400);
    }

    log.info("partslink.login.submitting");
    // Each field has onkeyup="txtChanged()" which enables the login button
    // and marks the form ready. Playwright's fill() doesn't fire keyup so
    // we use pressSequentially() to simulate real key events. Also call
    // txtChanged() explicitly as a belt-and-braces measure.
    await page.locator(SEL.companyId).pressSequentially(config.partslink24.companyId, { delay: 15 });
    await page.locator(SEL.username).pressSequentially(config.partslink24.username, { delay: 15 });
    await page.locator(SEL.password).pressSequentially(config.partslink24.accessCode, { delay: 15 });
    await page.evaluate(() => { if (typeof txtChanged === "function") txtChanged(); });

    // The login is AJAX — the submit button's onclick calls
    // `doLoginAjax(false)` and `return false`s on the form submit. Calling
    // `form.submit()` bypasses the real login, so we invoke the page-
    // provided function and then wait for the portal to redirect us.
    await page.evaluate(() => {
      if (typeof doLoginAjax === "function") doLoginAjax(false);
      else document.forms["loginForm"]?.submit();
    });

    // Wait for either the AJAX redirect (URL changes away from /login.do),
    // the session-squeeze-out prompt (already-logged-in elsewhere), or an
    // error in #loginErrorDiv.
    await page.waitForFunction(
      () => {
        const err = document.querySelector("#loginErrorDiv");
        const hasError = err && err.innerText && err.innerText.trim().length > 0;
        const squeeze = document.querySelector("#sessionSqueezeOutPrompt");
        const squeezeVisible = squeeze && getComputedStyle(squeeze).display !== "none";
        const offLogin = !location.pathname.includes("/login.do");
        return offLogin || hasError || squeezeVisible;
      },
      undefined,
      { timeout: config.browser.navTimeoutMs },
    ).catch(() => {});

    // Handle the "you're already logged in elsewhere" prompt by confirming
    // — this calls doLoginAjax(true) which kills the stale session.
    const squeezeVisible = await page.evaluate(() => {
      const s = document.querySelector("#sessionSqueezeOutPrompt");
      return !!s && getComputedStyle(s).display !== "none";
    }).catch(() => false);
    if (squeezeVisible) {
      log.info("partslink.login.squeezeout_confirm");
      await page.evaluate(() => {
        if (typeof doLoginAjax === "function") doLoginAjax(true);
      });
      await page.waitForFunction(
        () => !location.pathname.includes("/login.do"),
        undefined,
        { timeout: config.browser.navTimeoutMs },
      ).catch(() => {});
    }

    await page.waitForTimeout(1500);

    // Read any error message, then verify by navigating to root and
    // checking the portal renders (has VIN search form).
    const errText = await page
      .locator("#loginErrorDiv").first().innerText()
      .then((s) => s?.trim() || null)
      .catch(() => null);

    // PartsLink24 shows a "LOADING..." splash after successful login that
    // can take 5-10s to transition to startup.do. Give it room.
    await page.goto(config.partslink24.baseUrl, { waitUntil: "domcontentloaded" });
    const reallyLoggedIn = await page
      .locator('form[name="search-text"] input[name="text"]').first()
      .waitFor({ state: "visible", timeout: 20_000 })
      .then(() => true)
      .catch(() => false);

    if (!reallyLoggedIn) {
      const screenshot = await captureFailure(page, "login-failed");
      lastLoginFailureAt = Date.now();
      lastLoginFailureMessage = errText || "credentials may be incorrect or session was rejected";
      log.error("partslink.login.failed", { errText, screenshot, url: page.url(), cooldownMin: LOGIN_COOLDOWN_MS / 60_000 });
      throw new UpstreamError("PartsLink24 login failed", {
        url: page.url(),
        message: lastLoginFailureMessage,
        screenshot,
      });
    }

    // Fresh login succeeded — reset circuit breaker.
    lastLoginFailureAt = 0;
    lastLoginFailureMessage = null;

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
