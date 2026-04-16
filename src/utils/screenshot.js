// Save a full-page screenshot on failure. File path is returned so the caller
// can include it in logs / error responses. Never throws — screenshot capture
// must not mask the original error.

const fs = require("node:fs/promises");
const path = require("node:path");
const config = require("../config");

function safeTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function captureFailure(page, label) {
  try {
    await fs.mkdir(config.paths.artifactsDir, { recursive: true });
    const file = path.join(
      config.paths.artifactsDir,
      `${label}-${safeTimestamp()}.png`,
    );
    await page.screenshot({ path: file, fullPage: true });
    return file;
  } catch {
    return null;
  }
}

module.exports = { captureFailure };
