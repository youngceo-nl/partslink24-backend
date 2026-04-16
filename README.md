# car-part-scraper

Browser-automation backend around [PartsLink24](https://www.partslink24.com).
Exposes a small HTTP API so a frontend can:

- log in to PartsLink24 (Playwright)
- open a brand catalog (`audi_parts`, `bmw_parts`, `mercedes_parts`, …)
- decode a VIN
- look up a part number (+ image URL when available)

Written to replace the Auto.dev VIN step in the dismantling-price-calculator
pipeline.

## Quick start

```bash
cp .env.example .env
# fill in PARTSLINK24_COMPANY_ID, PARTSLINK24_USERNAME, PARTSLINK24_ACCESS_CODE
npm install              # also runs `playwright install chromium`
npm run dev              # hot-reload via nodemon
# or
npm start                # production
```

Health:

```bash
curl http://localhost:3000/health
```

## Environment variables

| Var | Required | Notes |
| --- | -------- | ----- |
| `PARTSLINK24_COMPANY_ID` | yes | e.g. `nl-620935` |
| `PARTSLINK24_USERNAME` | yes | |
| `PARTSLINK24_ACCESS_CODE` | yes | stored as plaintext in `.env` only |
| `PORT` | no | default `3000` |
| `HEADLESS` | no | `true` (default) in prod; `false` to watch the browser |
| `PARTSLINK24_BASE_URL` | no | default `https://www.partslink24.com` |
| `BROWSER_NAV_TIMEOUT_MS` | no | default `45000` |
| `BROWSER_ACTION_TIMEOUT_MS` | no | default `15000` |
| `SESSION_FILE` | no | default `./sessions/partslink24.json` |

Never commit `.env` — it's already in `.gitignore`.

## API

All responses use a consistent envelope:

```jsonc
// success
{ "success": true, "data": { ... }, "meta": { "source": "partslink24", "timestamp": "...", "sessionReused": true } }

// failure
{ "success": false, "error": { "message": "...", "code": "...", "details": { ... } }, "meta": { ... } }
```

### `GET /health`

Returns uptime + whether a persisted PartsLink24 session exists on disk.

### `POST /api/partslink/login`

```jsonc
// body: {}            (reuse existing session if available)
// body: { "force": true }   (force a fresh login)
```

Launches the browser (first call only), signs in if needed, saves cookies to
`sessions/partslink24.json`.

### `POST /api/partslink/decode-vin`

```jsonc
{ "vin": "WDDGJ4HB2FG386566" }       // brand auto-detected from WMI
{ "vin": "...", "brand": "audi" }    // explicit brand override
```

### `POST /api/partslink/lookup-part`

```jsonc
{ "vin": "...", "partNumber": "A2059050400" }     // VIN narrows the search
{ "brand": "audi", "partNumber": "8W0941035H" }   // catalog-wide search
```

### `POST /api/partslink/full-lookup`

```jsonc
{ "vin": "...", "partNumber": "..." }
```

Runs `decode-vin` then `lookup-part` and returns `{ vehicle, part }`.

## How it works

- **Single browser, single context** — chromium launches once per process and
  all requests reuse the same `BrowserContext`. Each request gets its own
  short-lived `Page`. See [`src/services/browser.js`](src/services/browser.js).
- **Session persistence** — `context.storageState()` is serialized to
  `sessions/partslink24.json` after every successful login. A process restart
  reuses the session and skips the login step.
- **Login flow** — the portal serves an interstitial on deep-links
  (`/login.do`), so we always navigate from the root domain. Form fields
  discovered live: `accountLogin`, `userLogin`, `loginBean.password`.
- **Catalogs** — each OEM brand is a separate React SPA reached via
  `launchCatalog.do?service={slug}_parts`. The VIN + part search widgets
  share the same `data-test-id` attributes (`vehicleSearchInput`,
  `partSearchInput`) across brands. The mapping from VIN WMI → slug lives in
  [`src/services/vin.js`](src/services/vin.js).
- **Cookie consent** — Usercentrics banner is dismissed automatically on the
  first visit; the preference persists in the saved session.
- **Failure capture** — any error inside a page action screenshots the full
  page to `artifacts/screenshots/{label}-{timestamp}.png` and includes the
  path in the JSON error response.

## Known limitations

- **Demo / unsubscribed brands** — for any brand the account doesn't hold
  an active subscription to, PartsLink24 disables the VIN + part inputs and
  renders a repeating "demo" watermark. The API surfaces this as
  `code: "demo_mode"` or `code: "vin_input_disabled"` rather than timing
  out. Activate the subscription for that brand to unblock.
- **Dealer selection** — when no dealer is assigned the catalog shows a
  "Dealer selecteren" button and the search inputs are disabled. We don't
  auto-pick a dealer (picking the wrong one affects order flows). Sign in
  through the web UI once and select a default dealer.
- **Per-brand field extraction** — the service fills the VIN + part inputs
  and returns the raw companion-panel text + any image URL it finds. Brand-
  specific parsers (into structured make/model/year/trim/engine) aren't
  written yet — the companion text is the safest cross-brand source until
  we have one pilot brand fully wired.
- **Headful in dev** — set `HEADLESS=false` in `.env` to watch the browser
  while debugging selectors.

## Deploying to DigitalOcean

### App Platform (recommended)

1. Create a new App → GitHub → pick this repo → branch `main`.
2. Build command: `npm install` (the `postinstall` step runs `playwright
   install chromium`).
3. Run command: `npm start`.
4. HTTP port: `3000`.
5. Instance size: at least **Basic / 1GB RAM** — chromium needs ~800 MB.
6. Add the three `PARTSLINK24_*` environment variables in the App spec, as
   encrypted secrets.

Chromium shared libraries (libnss, libatk, libcups …) are present in the
App Platform Node.js buildpack image, so no custom Dockerfile is required
for the default deploy path.

### Droplet (custom)

If you need persistent session storage across deploys, use a Droplet:

```bash
# Ubuntu 22.04
apt install -y nodejs npm
git clone https://github.com/essencesoftwaredevelopment/car-part-scraper.git
cd car-part-scraper
npm install
cp .env.example .env && $EDITOR .env
npx playwright install --with-deps chromium
pm2 start src/server.js --name partslink24
pm2 save
```

The `sessions/` and `artifacts/` directories are persisted on the Droplet
filesystem so the session survives restarts.

## Development scripts

- `npm run dev` — hot-reloading server
- `npm start` — production server
- `npm run probe:login` — dump the login form structure (`artifacts/probe/`)

Direct-invoke probes for selector discovery:

```bash
node scripts/probe-login.js                     # login page
node scripts/probe-login-direct.js              # confirms the interstitial
node scripts/probe-catalog.js <brand>           # brand catalog UI
node scripts/probe-dealer.js                    # dealer-selection modal
```

## Project layout

```
src/
  server.js              # Express bootstrap
  config/index.js        # env loading + fail-fast on missing creds
  routes/api.js          # route registration
  controllers/           # request handlers (thin)
    health.js
    login.js
    vin.js
    parts.js
    respond.js           # JSON envelope helper
  services/              # business logic (thick)
    browser.js           # Playwright lifecycle + storageState
    partslink.js         # login + session detection
    catalog.js           # brand-catalog helpers (selectors, cookies, gates)
    vin.js               # VIN validation + decode
    parts.js             # part-number lookup
  utils/
    logger.js            # JSON-lines with redaction
    errors.js            # typed error classes
    screenshot.js        # failure-capture helper
scripts/
  probe-*.js             # one-off live probes for selector discovery
sessions/                # gitignored — Playwright storageState
artifacts/               # gitignored — failure screenshots + probe dumps
```
