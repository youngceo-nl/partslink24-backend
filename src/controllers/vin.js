const { decodeVin } = require("../services/vin");
const { ok, fail } = require("./respond");

async function postDecodeVin(req, res) {
  try {
    const { vin } = req.body ?? {};
    const data = await decodeVin(vin);
    return ok(res, data);
  } catch (err) {
    return fail(res, err);
  }
}

module.exports = { postDecodeVin };
