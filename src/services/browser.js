// Singleton browser lifecycle. Launches chromium once per process and reuses
// a single BrowserContext so cookies/session state carry across requests.
// Persists context.storageState() to disk so a process restart doesn't force
// a fresh PartsLink24 login.
//
// Callers use `withPage(fn)` — pages are opened per-request and closed
// afterwards. The context is long-lived.

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
// playwright-extra + stealth fixes the headless-chrome fingerprints
// PartsLink24 detects (navigator.webdriver, chrome.runtime, missing
// plugins array, etc.) so we can run on a server without a display.
const { chromium } = require("playwright-extra");
const stealth = require("puppeteer-extra-plugin-stealth")();
chromium.use(stealth);
const config = require("../config");
const log = require("../utils/logger");

let browser = null;
let context = null;
let launching = null;

async function ensureBrowser() {
  if (browser && context) return { browser, context };
  if (launching) return launching;

  launching = (async () => {
    log.info("browser.launching", { headless: config.browser.headless });
    browser = await chromium.launch({
      headless: config.browser.headless,
      args: ["--disable-blink-features=AutomationControlled"],
    });

    const storageState = await loadStorageState();
    context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      locale: "nl-NL",
      storageState: storageState ?? undefined,
    });

    context.setDefaultNavigationTimeout(config.browser.navTimeoutMs);
    context.setDefaultTimeout(config.browser.actionTimeoutMs);

    // Auto-close handling — if the browser dies (process kill, crash),
    // reset state so the next request re-launches instead of hanging.
    browser.on("disconnected", () => {
      log.warn("browser.disconnected");
      browser = null;
      context = null;
    });

    log.info("browser.ready", { sessionLoaded: !!storageState });
    return { browser, context };
  })();

  try {
    return await launching;
  } finally {
    launching = null;
  }
}

async function loadStorageState() {
  try {
    const raw = await fsp.readFile(config.paths.sessionFile, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

async function saveStorageState() {
  if (!context) return;
  try {
    await fsp.mkdir(path.dirname(config.paths.sessionFile), { recursive: true });
    const state = await context.storageState();
    await fsp.writeFile(config.paths.sessionFile, JSON.stringify(state), "utf8");
    log.info("browser.session_saved", { path: config.paths.sessionFile });
  } catch (err) {
    log.warn("browser.session_save_failed", { message: err.message });
  }
}

async function clearStorageState() {
  try {
    if (fs.existsSync(config.paths.sessionFile)) {
      await fsp.unlink(config.paths.sessionFile);
    }
  } catch { /* ignore */ }
}

async function withPage(fn) {
  const { context: ctx } = await ensureBrowser();
  const page = await ctx.newPage();
  try {
    return await fn(page);
  } finally {
    await page.close().catch(() => {});
  }
}

async function shutdown() {
  try { await context?.close(); } catch { /* ignore */ }
  try { await browser?.close(); } catch { /* ignore */ }
  browser = null;
  context = null;
}

module.exports = {
  ensureBrowser,
  withPage,
  saveStorageState,
  clearStorageState,
  shutdown,
};
