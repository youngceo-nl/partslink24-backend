const { lookupPart } = require("../services/parts");
const { decodeVin } = require("../services/vin");
const { ok, fail } = require("./respond");

async function postLookupPart(req, res) {
  try {
    const { vin, brand, partNumber } = req.body ?? {};
    const data = await lookupPart({ vin, brand, partNumber });
    return ok(res, data);
  } catch (err) {
    return fail(res, err);
  }
}

async function postFullLookup(req, res) {
  try {
    const { vin, partNumber } = req.body ?? {};
    const vehicle = await decodeVin(vin);
    const part = await lookupPart({ vin, partNumber });
    return ok(res, { vehicle, part });
  } catch (err) {
    return fail(res, err);
  }
}

module.exports = { postLookupPart, postFullLookup };
