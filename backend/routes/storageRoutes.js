const express = require("express");
const multer = require("multer");
const { HttpError } = require("../utils/errors");
const { createStorageController } = require("../controllers/storageController");

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function buildStorageRouter({ config, provider }) {
  const router = express.Router();
  const controller = createStorageController({ config, provider });

  // Memory storage, hard-capped at MAX_UPLOAD_SIZE_MB: the encrypted payload is
  // held in RAM for the duration of the request (never written to disk).
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: config.maxUploadBytes, files: 1, fields: 0 },
  });
  const receiveFile = (req, res, next) =>
    upload.single("file")(req, res, (err) => {
      if (!err) return next();
      if (err.code === "LIMIT_FILE_SIZE") {
        return next(new HttpError(413, "FILE_TOO_LARGE", `Upload exceeds the ${Math.round(config.maxUploadBytes / 1024 / 1024)} MB limit.`));
      }
      return next(new HttpError(400, "INVALID_REQUEST", "Malformed upload request."));
    });

  router.get("/health", wrap(controller.health)); // must stay before "/:cid"
  router.post("/upload", receiveFile, wrap(controller.upload));
  router.get("/:cid/info", wrap(controller.info));
  router.get("/:cid", wrap(controller.retrieve));
  return router;
}

module.exports = { buildStorageRouter };
