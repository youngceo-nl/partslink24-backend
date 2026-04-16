// Shared JSON response shape. All successful responses go through `ok`,
// all failures through `fail`, so consumers see a stable envelope.

function ok(res, data, extraMeta = {}) {
  return res.json({
    success: true,
    data,
    meta: {
      source: "partslink24",
      timestamp: new Date().toISOString(),
      ...extraMeta,
    },
  });
}

function fail(res, err) {
  const status = err.status || 500;
  return res.status(status).json({
    success: false,
    error: {
      message: err.message || "Internal error",
      code: err.code || "internal_error",
      details: err.details ?? null,
    },
    meta: {
      source: "partslink24",
      timestamp: new Date().toISOString(),
    },
  });
}

module.exports = { ok, fail };
