const { ensureLoggedIn } = require("../services/partslink");
const { ok, fail } = require("./respond");

async function login(req, res) {
  try {
    const force = req.body?.force === true;
    const result = await ensureLoggedIn({ force });
    return ok(res, { loggedIn: result.loggedIn }, { sessionReused: result.sessionReused });
  } catch (err) {
    return fail(res, err);
  }
}

module.exports = { login };
