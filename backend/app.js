const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { HttpError } = require("./utils/errors");
const { buildStorageRouter } = require("./routes/storageRoutes");

// Builds the Express app from an already-validated config and a provider.
// Kept separate from server.js so tests can inject a fake provider.
function createApp({ config, provider }) {
  const app = express();
  app.disable("x-powered-by");
  app.use(helmet());
  app.use(cors({ origin: config.corsOrigins, methods: ["GET", "POST"] }));
  app.use(express.json({ limit: "10kb" }));

  app.get("/health", (req, res) => {
    res.json({ status: "ok", service: "decentralized-storage-backend" });
  });

  const limiter = rateLimit({
    windowMs: 60 * 1000,
    limit: config.rateLimitPerMinute,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests. Please slow down.", code: "RATE_LIMITED" },
  });
  app.use("/api/storage", limiter, buildStorageRouter({ config, provider }));

  app.use((req, res) => {
    res.status(404).json({ error: "Not found.", code: "NOT_FOUND" });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: err.message, code: err.code });
    }
    if (err?.type === "entity.too.large" || err?.type === "entity.parse.failed") {
      return res.status(400).json({ error: "Invalid request body.", code: "INVALID_REQUEST" });
    }
    // Log the message only (no request bodies, no stack in the response).
    console.error(`[backend] unexpected error: ${err?.name}: ${err?.message}`);
    res.status(500).json({ error: "Internal server error.", code: "INTERNAL_ERROR" });
  });

  return app;
}

module.exports = { createApp };
