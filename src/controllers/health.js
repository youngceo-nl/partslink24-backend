const { sessionStatus } = require("../services/partslink");
const { ok } = require("./respond");

const bootedAt = Date.now();

async function health(_req, res) {
  const s = await sessionStatus();
  return ok(res, {
    status: "ok",
    uptimeSeconds: Math.round((Date.now() - bootedAt) / 1000),
    session: s,
  });
}

module.exports = { health };
