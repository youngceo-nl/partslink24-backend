const { Router } = require("express");
const { health } = require("../controllers/health");
const { login } = require("../controllers/login");
const { postDecodeVin } = require("../controllers/vin");
const { postLookupPart, postFullLookup } = require("../controllers/parts");

const router = Router();

router.get("/health", health);

router.post("/api/partslink/login", login);
router.post("/api/partslink/decode-vin", postDecodeVin);
router.post("/api/partslink/lookup-part", postLookupPart);
router.post("/api/partslink/full-lookup", postFullLookup);

module.exports = router;
