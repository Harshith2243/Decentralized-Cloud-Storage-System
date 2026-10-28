// Central, validated configuration. Reads ONLY from the environment passed in
// (server.js loads .env first). Secrets live here on the server and are never
// sent to the browser or logged.

const SUPPORTED_PROVIDERS = ["kubo"];

class ConfigError extends Error {
  constructor(problems) {
    super(`Invalid backend configuration:\n - ${problems.join("\n - ")}`);
    this.name = "ConfigError";
    this.problems = problems;
  }
}

function readNumber(env, name, fallback, { min, max, integer = true }, problems) {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || (integer && !Number.isInteger(value)) || value < min || value > max) {
    problems.push(`${name} must be ${integer ? "an integer" : "a number"} between ${min} and ${max} (got "${raw}")`);
    return fallback;
  }
  return value;
}

function loadConfig(env = process.env) {
  const problems = [];
  const warnings = [];

  const provider = (env.IPFS_PROVIDER || "kubo").toLowerCase();
  if (!SUPPORTED_PROVIDERS.includes(provider)) {
    problems.push(`IPFS_PROVIDER "${provider}" is not supported (supported: ${SUPPORTED_PROVIDERS.join(", ")})`);
  }

  const apiUrlRaw = env.IPFS_API_URL || "http://127.0.0.1:5001";
  let apiUrl = null;
  try {
    const parsed = new URL(apiUrlRaw);
    if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("bad protocol");
    apiUrl = parsed.href.replace(/\/+$/, "");
    const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname);
    if (!loopback && parsed.protocol === "http:") {
      warnings.push("IPFS_API_URL is a non-local http:// address. Use https and never expose a raw Kubo RPC API publicly.");
    }
  } catch {
    problems.push("IPFS_API_URL must be a valid http(s) URL");
  }

  const maxUploadMb = readNumber(env, "MAX_UPLOAD_SIZE_MB", 101, { min: 1, max: 500, integer: false }, problems);
  const ipfsTimeoutMs = readNumber(env, "IPFS_TIMEOUT_MS", 30000, { min: 1000, max: 600000 }, problems);
  const ipfsRetrieveTimeoutMs = readNumber(env, "IPFS_RETRIEVE_TIMEOUT_MS", 120000, { min: 1000, max: 900000 }, problems);
  const port = readNumber(env, "PORT", 5000, { min: 1, max: 65535 }, problems);
  const rateLimitPerMinute = readNumber(env, "RATE_LIMIT_PER_MINUTE", 60, { min: 1, max: 100000 }, problems);

  const corsOrigins = (env.CORS_ORIGIN || "http://localhost:5173,http://127.0.0.1:5173")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (corsOrigins.includes("*")) problems.push('CORS_ORIGIN must list explicit origins, not "*"');

  if (problems.length) throw new ConfigError(problems);

  return Object.freeze({
    port,
    corsOrigins,
    rateLimitPerMinute,
    maxUploadBytes: Math.floor(maxUploadMb * 1024 * 1024),
    warnings,
    ipfs: Object.freeze({
      provider,
      apiUrl,
      apiToken: env.IPFS_API_TOKEN || "", // optional; sent only to apiUrl, never logged
      timeoutMs: ipfsTimeoutMs,
      retrieveTimeoutMs: ipfsRetrieveTimeoutMs,
    }),
  });
}

module.exports = { loadConfig, ConfigError, SUPPORTED_PROVIDERS };
