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
 * Detect post-login state via DOM, not URL. The partslink24 homepage embeds
 * the login form as a sidebar panel, so a stale-session user lands on a URL
 * that doesn't contain /login.do while still being logged out — checking the
 * URL alone silently reuses broken sessions forever.
 */
async function isLoggedIn(page) {
  // Give the page a beat to render after domcontentloaded — form elements
  // can have display:none until CSS/JS runs.
  await page.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => {});

  // Evaluate both signals synchronously in the DOM to sidestep Playwright
  // visibility timing quirks. offsetParent===null is the cheap check for
  // "actually painted".
  const state = await page.evaluate(() => {
    const search = document.querySelector('form[name="search-text"] input[name="text"]');
    const login = document.querySelector('input[name="accountLogin"]');
    return {
      searchVisible: !!search && search.offsetParent !== null,
      loginVisible: !!login && login.offsetParent !== null,
    };
  }).catch(() => ({ searchVisible: false, loginVisible: true }));

  if (state.searchVisible) return true;
  return !state.loginVisible;
}

async function hasSessionFile() {
  try {
    const s = await fs.stat(config.paths.sessionFile);
    return s.isFile() && s.size > 0;
  } catch {
    return false;
  }
}

// Track the last login failure for diagnostics only — no cooldown.
// Every incoming request gets a fresh login attempt if the session is stale.
let lastLoginFailureMessage = null;

/**
 * Dismiss any cookie banners or consent overlays on the page.
 * Handles Usercentrics (UC_UI JS API + button click) and generic
 * cookie/consent overlays that might block interaction.
 */
async function dismissOverlays(page) {
  // 1. Usercentrics JS API — works whether or not the banner is visible.
  await page.evaluate(() => {
    const ui = window.UC_UI;
    if (ui?.acceptAllConsents) ui.acceptAllConsents().catch(() => {});
    else if (ui?.closeCMP) ui.closeCMP();
  }).catch(() => {});
  await page.waitForTimeout(300);

  // 2. Force-click any Usercentrics accept button still in the DOM.
  const ucBtn = page.locator(
    'button[data-testid="uc-accept-all-button"], [data-testid="uc-container"] button',
  ).first();
  if (await ucBtn.count() > 0) {
    await ucBtn.click({ force: true, timeout: 2000 }).catch(() => {});
    await page.waitForTimeout(300);
  }

  // 3. Generic cookie/consent overlays — accept or close buttons with
  //    common labels. Force-click so overlays behind other overlays don't
  //    block the action.
  for (const selector of [
    'button:has-text("Accept")',
    'button:has-text("Accepteren")',
    'button:has-text("Akzeptieren")',
    'button:has-text("Accept all")',
    'a:has-text("Accept")',
    '[class*="cookie"] button',
    '[class*="consent"] button',
    '[id*="cookie"] button',
    '[id*="consent"] button',
  ]) {
    const btn = page.locator(selector).first();
    if (await btn.isVisible({ timeout: 300 }).catch(() => false)) {
      await btn.click({ force: true, timeout: 2000 }).catch(() => {});
      await page.waitForTimeout(200);
      break;
    }
  }
}

/**
 * Handle the "you're already logged in elsewhere" session squeeze-out
 * prompt. Confirms the takeover so the stale session is killed.
 * Returns true if the prompt was found and handled.
 */
async function handleSqueezeOut(page) {
  const squeezeVisible = await page.evaluate(() => {
    const s = document.querySelector("#sessionSqueezeOutPrompt");
    return !!s && getComputedStyle(s).display !== "none";
  }).catch(() => false);

  if (!squeezeVisible) return false;

  log.info("partslink.login.squeezeout_confirm");
  await page.evaluate(() => {
    if (typeof doLoginAjax === "function") doLoginAjax(true);
  });
  await page.waitForFunction(
    () => !location.pathname.includes("/login.do"),
    undefined,
    { timeout: config.browser.navTimeoutMs },
  ).catch(() => {});
  return true;
}

/**
 * Fill and submit the login form. Waits for the page to leave /login.do
 * (success) or for an error to appear (failure). Returns { success, errText }.
 */
async function fillAndSubmitLogin(page) {
  await page.waitForSelector(SEL.companyId, { timeout: config.browser.actionTimeoutMs });
  await dismissOverlays(page);

  log.info("partslink.login.submitting");

  // fill() sets the value instantly. Call txtChanged() once after to enable
  // the submit button (the form uses onkeyup="txtChanged()").
  for (const [sel, val] of [
    [SEL.companyId, config.partslink24.companyId],
    [SEL.username, config.partslink24.username],
    [SEL.password, config.partslink24.accessCode],
  ]) {
    await page.locator(sel).fill(val);
  }
  await page.evaluate(() => { if (typeof txtChanged === "function") txtChanged(); });

  // Dismiss overlays again right before submitting — Usercentrics can
  // re-show the banner asynchronously and swallow the click.
  await dismissOverlays(page);

  // The login is AJAX — submit via the page's doLoginAjax().
  await page.evaluate(() => {
    if (typeof doLoginAjax === "function") doLoginAjax(false);
    else document.forms["loginForm"]?.submit();
  });

  // Wait for redirect, error, or squeeze-out prompt.
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

  // Handle session squeeze-out if it appeared.
  await handleSqueezeOut(page);

  // Check result immediately — no extra waits.
  const onLogin = page.url().includes("/login.do");
  if (onLogin) {
    const errText = await page
      .locator("#loginErrorDiv").first().innerText()
      .then((s) => s?.trim() || null)
      .catch(() => null);
    return { success: false, errText };
  }
  return { success: true, errText: null };
}

/**
 * Ensure the current context is authenticated. Returns whether a fresh login
 * happened (vs. the existing session being reused).
 *
 * Flow:
 *   1. Open the login page.
 *   2. Dismiss any cookie banners / consent overlays.
 *   3. If a session squeeze-out prompt appears, confirm it.
 *   4. If login still fails, refresh and retry once before giving up.
 */
async function ensureLoggedIn({ force = false } = {}) {
  const sessionExists = await hasSessionFile();

  return withPage(async (page) => {
    await page.goto(config.partslink24.baseUrl, { waitUntil: "domcontentloaded" });

    if (!force && sessionExists && (await isLoggedIn(page))) {
      log.info("partslink.login.reused", { url: page.url() });
      return { loggedIn: true, sessionReused: true };
    }

    // --- Attempt 1 ---
    const r1 = await fillAndSubmitLogin(page);

    if (r1.success) {
      lastLoginFailureMessage = null;
      await saveStorageState();
      log.info("partslink.login.success", { url: page.url(), attempt: 1 });
      return { loggedIn: true, sessionReused: false };
    }

    // --- Attempt 2: clear session and retry from scratch ---
    log.warn("partslink.login.retry", { errText: r1.errText, url: page.url() });
    await clearStorageState();
    await page.goto(LOGIN_URL(), { waitUntil: "domcontentloaded" });

    const r2 = await fillAndSubmitLogin(page);

    if (r2.success) {
      lastLoginFailureMessage = null;
      await saveStorageState();
      log.info("partslink.login.success", { url: page.url(), attempt: 2 });
      return { loggedIn: true, sessionReused: false };
    }

    // Both attempts failed — log and throw, but NO cooldown.
    // Next request will try again immediately.
    const screenshot = await captureFailure(page, "login-failed");
    lastLoginFailureMessage = r2.errText || r1.errText || "credentials may be incorrect or session was rejected";
    log.error("partslink.login.failed", {
      errText: lastLoginFailureMessage, screenshot, url: page.url(),
    });
    throw new UpstreamError("PartsLink24 login failed", {
      url: page.url(),
      message: lastLoginFailureMessage,
      screenshot,
    });
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
