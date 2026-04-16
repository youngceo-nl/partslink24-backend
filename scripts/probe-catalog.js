// Post-login probe: launches a brand catalog and dumps its structure so we
// can write the VIN + part search flow. Reuses the saved storageState so
// we don't re-login on every probe run.
//
// Usage: node scripts/probe-catalog.js [brand]
// Example: node scripts/probe-catalog.js mercedes-benz

const fs = require("node:fs/promises");
const path = require("node:path");
const { chromium } = require("playwright");
require("dotenv").config();

const brand = process.argv[2] || "mercedes-benz";
const OUT = path.resolve(process.cwd(), "artifacts", `probe-catalog-${brand}`);
const SESSION_FILE = path.resolve(process.cwd(), "sessions", "partslink24.json");

(async () => {
  await fs.mkdir(OUT, { recursive: true });
  let storageState;
  try { storageState = JSON.parse(await fs.readFile(SESSION_FILE, "utf8")); }
  catch { console.error("[probe] no session file — run login first"); process.exit(1); }

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, storageState });
  const page = await ctx.newPage();

  const url = `https://www.partslink24.com/partslink24/launchCatalog.do?service=${encodeURIComponent(`${brand}_parts`)}`;
  console.log(`[probe-catalog] goto ${url}`);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(5000);

  console.log("[probe-catalog] url:", page.url());
  console.log("[probe-catalog] title:", await page.title());

  // Inspect frames — catalogs often embed their UI in iframes.
  const frames = page.frames();
  console.log(`[probe-catalog] ${frames.length} frames:`);
  for (const f of frames) {
    console.log("  -", f.url(), "| name:", f.name());
  }

  // Dump top-level and each frame
  await page.screenshot({ path: path.join(OUT, "page.png"), fullPage: true });
  await fs.writeFile(path.join(OUT, "page.html"), await page.content());
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    try {
      const html = await f.content();
      await fs.writeFile(path.join(OUT, `frame-${i}.html`), html);
      const probe = await f.evaluate(() => {
        const has = (sel) => Array.from(document.querySelectorAll(sel)).filter(el => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        }).length;
        const inputs = Array.from(document.querySelectorAll("input,select"))
          .filter(el => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          })
          .map(el => ({ tag: el.tagName, name: el.name || null, id: el.id || null, type: el.type || null, placeholder: el.placeholder || null }));
        const buttons = Array.from(document.querySelectorAll("button"))
          .map(el => ({ text: el.innerText.trim().slice(0, 80), id: el.id || null, name: el.name || null }));
        const texts = Array.from(document.querySelectorAll("label, h1, h2, h3, h4"))
          .map(el => el.innerText.trim()).filter(Boolean).slice(0, 40);
        return { url: location.href, title: document.title, inputs, buttons, labels: texts };
      });
      await fs.writeFile(path.join(OUT, `frame-${i}-probe.json`), JSON.stringify(probe, null, 2));
      console.log(`[probe-catalog] frame ${i} probe:`, JSON.stringify(probe.inputs).slice(0, 300));
    } catch (err) {
      console.log(`[probe-catalog] frame ${i} inaccessible:`, err.message);
    }
  }

  await browser.close();
})();
