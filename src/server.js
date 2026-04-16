// HTTP entrypoint. Loads env, starts Express, wires graceful shutdown so the
// Playwright browser closes on SIGTERM (important for DigitalOcean restarts).

const path = require("node:path");
const express = require("express");
const config = require("./config");
const log = require("./utils/logger");
const routes = require("./routes/api");
const { fail } = require("./controllers/respond");
const { shutdown } = require("./services/browser");

// Fail fast on missing credentials — better to crash on boot than mid-request.
config.assertCredentials();

const app = express();
app.use(express.json({ limit: "256kb" }));

// Minimal request logging — method, path, status, duration. No bodies (PII).
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    log.info("http", {
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs: Date.now() - start,
    });
  });
  next();
});

// Serve captured vehicle images from the Graphical Navigation panel. CORS
// is wide-open because the intended consumer is the price-calculator
// frontend running on a different origin, and these are not secrets —
// they're derivations of a paid PartsLink24 subscription.
app.use(
  "/vehicle-images",
  (req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "public, max-age=86400");
    next();
  },
  express.static(path.resolve(process.cwd(), "artifacts", "vehicle-images"), {
    fallthrough: false,
  }),
);

app.use(routes);

// 404
app.use((req, res) => {
  return fail(res, { message: `Not found: ${req.method} ${req.path}`, code: "not_found", status: 404 });
});

// Central error handler — catches sync throws; async errors are handled per-controller.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  log.error("http.error", { message: err.message, stack: err.stack });
  return fail(res, err);
});

const server = app.listen(config.port, () => {
  log.info("server.listening", { port: config.port, headless: config.browser.headless });
});

async function gracefulShutdown(signal) {
  log.info("server.shutdown", { signal });
  server.close();
  await shutdown();
  process.exit(0);
}
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
