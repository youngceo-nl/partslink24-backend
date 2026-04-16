// Small structured logger — JSON lines so logs are grep-friendly on
// DigitalOcean while still readable locally. Never logs credentials.

const REDACT_KEYS = new Set([
  "accessCode",
  "password",
  "cookie",
  "cookies",
  "authorization",
  "PARTSLINK24_ACCESS_CODE",
]);

function redact(obj) {
  if (obj === null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(redact);
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (REDACT_KEYS.has(k)) {
      out[k] = "***";
      continue;
    }
    out[k] = redact(v);
  }
  return out;
}

function write(level, event, payload) {
  const line = { ts: new Date().toISOString(), level, event };
  if (payload !== undefined) line.payload = redact(payload);
  const json = JSON.stringify(line);
  if (level === "error") console.error(json);
  else if (level === "warn") console.warn(json);
  else console.log(json);
}

module.exports = {
  info: (event, payload) => write("info", event, payload),
  warn: (event, payload) => write("warn", event, payload),
  error: (event, payload) => write("error", event, payload),
};
