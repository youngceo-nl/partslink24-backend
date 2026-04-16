// Live-probe the PartsLink24 login page. Dumps form structure + screenshot
// so we can pick stable selectors. Usage: `node scripts/probe-login.js`
// Runs headless by default; set HEADLESS=false to watch.

const fs = require("node:fs/promises");
const path = require("node:path");
const { chromium } = require("playwright");
require("dotenv").config();

const OUT_DIR = path.resolve(process.cwd(), "artifacts", "probe");

(async () => {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const headless = (process.env.HEADLESS ?? "true") !== "false";
  const browser = await chromium.launch({ headless });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

  const url = process.env.PARTSLINK24_BASE_URL || "https://www.partslink24.com";
  console.log(`[probe] goto ${url}`);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(2500);

  console.log(`[probe] final url: ${page.url()}`);
  console.log(`[probe] title: ${await page.title()}`);

  // Dump all visible inputs + buttons + form actions so we can see the login
  // form structure without a browser window.
  const formInfo = await page.evaluate(() => {
    const rect = (el) => {
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    };
    const visible = (el) => {
      const s = getComputedStyle(el);
      if (s.display === "none" || s.visibility === "hidden") return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const inputs = Array.from(document.querySelectorAll("input,select,textarea"))
      .filter(visible)
      .map((el) => ({
        tag: el.tagName.toLowerCase(),
        type: el.type || null,
        name: el.name || null,
        id: el.id || null,
        placeholder: el.placeholder || null,
        labelText: (el.labels && el.labels[0]?.innerText) || null,
        rect: rect(el),
      }));
    const buttons = Array.from(document.querySelectorAll("button, input[type=submit]"))
      .filter(visible)
      .map((el) => ({
        tag: el.tagName.toLowerCase(),
        type: el.type || null,
        text: (el.innerText || el.value || "").trim().slice(0, 80),
        id: el.id || null,
        name: el.name || null,
        rect: rect(el),
      }));
    const forms = Array.from(document.querySelectorAll("form")).map((f) => ({
      action: f.getAttribute("action"),
      method: f.getAttribute("method"),
      id: f.id || null,
      name: f.name || null,
    }));
    return { inputs, buttons, forms, hrefs: Array.from(document.querySelectorAll("a[href]")).slice(0, 40).map((a) => ({ text: a.innerText.trim().slice(0, 60), href: a.href })) };
  });

  const payload = {
    probedAt: new Date().toISOString(),
    finalUrl: page.url(),
    title: await page.title(),
    ...formInfo,
  };

  await fs.writeFile(path.join(OUT_DIR, "login-form.json"), JSON.stringify(payload, null, 2));
  await page.screenshot({ path: path.join(OUT_DIR, "login-page.png"), fullPage: true });
  await fs.writeFile(path.join(OUT_DIR, "login-page.html"), await page.content());
  console.log(`[probe] saved artifacts to ${OUT_DIR}`);

  await browser.close();
})().catch((err) => {
  console.error("[probe] failed:", err);
  process.exit(1);
});
