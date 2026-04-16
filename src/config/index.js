// Centralised env loading + validation. Every other module reads from here
// rather than touching process.env directly so required secrets fail fast at
// boot instead of deep in a request.

require("dotenv").config();

const path = require("path");

const REQUIRED_CREDS = [
  "PARTSLINK24_COMPANY_ID",
  "PARTSLINK24_USERNAME",
  "PARTSLINK24_ACCESS_CODE",
];

function boolEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return raw === "true" || raw === "1";
}

function intEnv(name, fallback) {
  const n = parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) ? n : fallback;
}

function assertCredentials() {
  const missing = REQUIRED_CREDS.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required env var(s): ${missing.join(", ")} — copy .env.example to .env`,
    );
  }
}

const config = {
  port: intEnv("PORT", 3000),

  partslink24: {
    baseUrl: process.env.PARTSLINK24_BASE_URL || "https://www.partslink24.com",
    companyId: process.env.PARTSLINK24_COMPANY_ID || "",
    username: process.env.PARTSLINK24_USERNAME || "",
    accessCode: process.env.PARTSLINK24_ACCESS_CODE || "",
  },

  browser: {
    headless: boolEnv("HEADLESS", true),
    navTimeoutMs: intEnv("BROWSER_NAV_TIMEOUT_MS", 45_000),
    actionTimeoutMs: intEnv("BROWSER_ACTION_TIMEOUT_MS", 15_000),
  },

  paths: {
    sessionFile: process.env.SESSION_FILE
      ? path.resolve(process.env.SESSION_FILE)
      : path.resolve(process.cwd(), "sessions", "partslink24.json"),
    artifactsDir: path.resolve(process.cwd(), "artifacts", "screenshots"),
  },

  assertCredentials,
};

module.exports = config;
