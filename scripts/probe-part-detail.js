// Reuse the saved session, navigate directly to a part-search URL the
// user supplied, click the first result row, and dump:
//   - the table headers (name / category columns)
//   - the first data row (part name, category)
//   - the .draw-target canvas rendered as a PNG
// This tells us what selectors the improved extractor needs.

const fs = require("node:fs/promises");
const path = require("node:path");
const { chromium } = require("playwright-extra");
const stealth = require("puppeteer-extra-plugin-stealth")();
chromium.use(stealth);
require("dotenv").config();

const SEARCH_URL =
  "https://www.partslink24.com/pl24-app/audi_parts/WAUZZZGY0MA078367/0/search?q=8Y0945257A";

const OUT = path.resolve(process.cwd(), "artifacts", "probe-part-detail");
const SESSION_FILE = path.resolve(process.cwd(), "sessions", "partslink24.json");

async function main() {
  await fs.mkdir(OUT, { recursive: true });

  const browser = await chromium.launch({ headless: false });
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    locale: "nl-NL",
  });
  await ctx.route(
    /usercentrics\.(eu|com|org)|app\.usercentrics|uc-api/i,
    (route) => route.abort(),
  );
  const page = await ctx.newPage();

  // Fresh login — doesn't rely on a possibly-stale saved session.
  console.log("[probe] logging in fresh…");
  await page.goto("https://www.partslink24.com", { waitUntil: "domcontentloaded" });
  await page.waitForSelector('input[name="accountLogin"]', { timeout: 15_000 });
  for (const [sel, val] of [
    ['input[name="accountLogin"]', process.env.PARTSLINK24_COMPANY_ID],
    ['input[name="userLogin"]', process.env.PARTSLINK24_USERNAME],
    ['input[name="loginBean.password"]', process.env.PARTSLINK24_ACCESS_CODE],
  ]) {
    await page.locator(sel).click();
    await page.locator(sel).pressSequentially(val, { delay: 80 });
  }
  await page.evaluate(() => { if (typeof txtChanged === "function") txtChanged(); });
  await page.evaluate(() => { if (typeof doLoginAjax === "function") doLoginAjax(false); });

  // Handle the "your session is still active elsewhere — kill it and log
  // in here?" squeeze-out prompt. doLoginAjax(true) confirms.
  await page.waitForTimeout(1500);
  const squeezeVisible = await page.evaluate(() => {
    const el = document.getElementById("sessionSqueezeOutPrompt");
    return !!el && getComputedStyle(el).display !== "none";
  }).catch(() => false);
  if (squeezeVisible) {
    console.log("[probe] session squeeze-out prompt → confirming");
    await page.evaluate(() => { if (typeof doLoginAjax === "function") doLoginAjax(true); });
  }

  await page.waitForSelector('form[name="search-text"] input[name="text"]', { timeout: 30_000 });
  console.log("[probe] logged in, navigating to part search…");

  // Save session for later reuse.
  await fs.writeFile(SESSION_FILE, JSON.stringify(await ctx.storageState()), "utf8");

  await page.goto(SEARCH_URL, { waitUntil: "domcontentloaded", timeout: 40_000 });
  await page.waitForTimeout(5000);

  console.log("[probe] search page:", page.url());
  await page.screenshot({ path: path.join(OUT, "01-search.png"), fullPage: true });

  // Extract structured data from the search-result sidebar using the
  // stable data-test-ids the catalog ships with (partnoValue, nameValue,
  // mgValue, sgValue, btnrValue). Each result row is [data-test-id="row"].
  const detail = await page.evaluate(() => {
    const text = (el) => (el?.innerText || "").replace(/\s+/g, " ").trim();
    const rows = Array.from(document.querySelectorAll('[data-test-id="row"]'));
    const parsed = rows.map((row) => ({
      partNo: text(row.querySelector('[data-test-id="partnoValue"] ._value_15k4v_1, [data-test-id="partnoValue"] span')),
      description: text(row.querySelector('[data-test-id="nameValue"] ._value_15k4v_1, [data-test-id="nameValue"] span')),
      mg: text(row.querySelector('[data-test-id="mgValue"] ._value_15k4v_1, [data-test-id="mgValue"] span')),
      sg: text(row.querySelector('[data-test-id="sgValue"] ._value_15k4v_1, [data-test-id="sgValue"] span')),
      illustration: text(row.querySelector('[data-test-id="btnrValue"] ._value_15k4v_1')),
      selected: row.querySelector('._selected_199vu_67') !== null ||
                row.firstElementChild?.className?.includes("_selected_") || false,
    })).filter((r) => r.partNo);

    // Right-hand table maps MG number → main-group name (Engine, Electrics, ...)
    const mgMap = {};
    for (const row of document.querySelectorAll("[data-test-id='row'], tr")) {
      const t = text(row);
      const m = t.match(/^(\d)\s+(.+?)(\s{2}|$)/);
      if (m && !mgMap[m[1]]) mgMap[m[1]] = m[2].slice(0, 60);
    }
    return { results: parsed, mgMap };
  });
  await fs.writeFile(path.join(OUT, "01-detail.json"), JSON.stringify(detail, null, 2));
  const first = detail.results[0];
  if (!first) {
    console.log("[probe] no results rows found");
  } else {
    const mainGroup = first.mg ? detail.mgMap[first.mg] ?? null : null;
    console.log("[probe] first result:", JSON.stringify({ ...first, mainGroup }));
  }

  // Click the first selected/selectable result row to drill into its
  // illustration page (which has the canvas.draw-target).
  const firstRow = page.locator('[data-test-id="row"]').first();
  if (await firstRow.count() > 0) {
    console.log("[probe] clicking first result row…");
    await firstRow.click();
    await page.waitForTimeout(5000);
    await page.screenshot({ path: path.join(OUT, "02-illustration.png"), fullPage: true });

    // Inspect every frame — the illustration may live in an iframe.
    console.log("[probe] frames:", page.frames().length);
    for (const f of page.frames()) {
      const info = await f.evaluate(() => {
        const cs = Array.from(document.querySelectorAll("canvas")).map((c) => ({
          className: c.className, width: c.width, height: c.height,
        }));
        const imgs = Array.from(document.querySelectorAll("img")).filter((i) => {
          const r = i.getBoundingClientRect(); return r.width > 150 && r.height > 100;
        }).map((i) => ({
          src: i.src.slice(0, 180), w: i.naturalWidth, h: i.naturalHeight,
        }));
        const svgs = Array.from(document.querySelectorAll("svg")).filter((s) => {
          const r = s.getBoundingClientRect(); return r.width > 150 && r.height > 100;
        }).map((s) => ({
          className: typeof s.className === "object" ? s.className.baseVal : s.className,
          box: (() => { const r = s.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; })(),
        }));
        return { url: location.href, canvases: cs, bigImages: imgs, bigSvgs: svgs };
      }).catch(() => ({ url: f.url(), error: true }));
      console.log(` frame ${f.url().slice(0, 100)}: canvases=${info.canvases?.length ?? "?"}, images=${info.bigImages?.length ?? "?"}, svgs=${info.bigSvgs?.length ?? "?"}`);
      if (info.canvases?.length) for (const c of info.canvases) console.log("    canvas:", c.className, `${c.width}x${c.height}`);
      if (info.bigImages?.length) for (const i of info.bigImages.slice(0, 5)) console.log("    img:", i.w, "x", i.h, i.src);
      if (info.bigSvgs?.length) for (const s of info.bigSvgs.slice(0, 3)) console.log("    svg:", s.className?.slice?.(0, 50), s.box);
    }

    // The diagram canvas lives inside <imageserver-weco>'s open shadow DOM —
    // `document.querySelector("canvas")` misses it. Walk into .shadowRoot.
    const canvasData = await page.evaluate(() => {
      const host = document.querySelector("imageserver-weco");
      const c = host?.shadowRoot?.querySelector("canvas.draw-target")
        || host?.shadowRoot?.querySelector("canvas");
      return c ? c.toDataURL("image/png") : null;
    });
    if (canvasData) {
      const b64 = canvasData.split(",", 2)[1];
      await fs.writeFile(path.join(OUT, "02-canvas.png"), Buffer.from(b64, "base64"));
      console.log(`[probe] canvas saved (${b64.length} base64 bytes)`);
    } else {
      console.log("[probe] imageserver-weco shadow root not reachable");
    }
  }

  console.log("\nBrowser stays open. Ctrl+C when done.\n");
  await new Promise(() => {});
}

main().catch((err) => {
  console.error("[probe] failed:", err);
  process.exit(1);
});
