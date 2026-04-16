// partslink24-scraper.js

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const input = args[0];
const targetUrl = input || 'https://www.partslink24.com/';

function ensureDirectory(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function getSafeTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function scrapePage(page) {
  return page.evaluate(() => {
    const normalizeText = (value) => (value || '').replace(/\s+/g, ' ').trim();

    const title = normalizeText(document.title);
    const metaDescription =
      document.querySelector('meta[name="description"]')?.getAttribute('content') || null;

    const headings = Array.from(document.querySelectorAll('h1, h2'))
      .map((el) => normalizeText(el.textContent))
      .filter(Boolean)
      .slice(0, 30);

    const links = Array.from(document.querySelectorAll('a[href]'))
      .map((anchor) => ({
        text: normalizeText(anchor.textContent),
        href: anchor.href,
      }))
      .filter((item) => item.href)
      .slice(0, 200);

    const bodyText = normalizeText(document.body?.innerText || '').slice(0, 4000);

    return {
      title,
      metaDescription,
      headings,
      links,
      bodyText,
    };
  });
}

(async () => {
  const outputDir = path.join(__dirname, 'scraped-data');
  ensureDirectory(outputDir);

  const timestamp = getSafeTimestamp();
  const outputJsonPath = path.join(outputDir, `partslink24-${timestamp}.json`);
  const outputHtmlPath = path.join(outputDir, `partslink24-${timestamp}.html`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 },
  });

  const page = await context.newPage();

  try {
    console.log(`Navigating to ${targetUrl} ...`);
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForTimeout(3000);

    const pageData = await scrapePage(page);
    const html = await page.content();

    const payload = {
      requestedUrl: targetUrl,
      finalUrl: page.url(),
      scrapedAt: new Date().toISOString(),
      ...pageData,
    };

    fs.writeFileSync(outputJsonPath, JSON.stringify(payload, null, 2), 'utf8');
    fs.writeFileSync(outputHtmlPath, html, 'utf8');

    console.log(`Saved JSON to ${outputJsonPath}`);
    console.log(`Saved HTML snapshot to ${outputHtmlPath}`);
  } catch (error) {
    console.error('Scrape failed:', error.message);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();