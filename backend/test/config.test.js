const test = require("node:test");
const assert = require("node:assert/strict");
const { loadConfig, ConfigError } = require("../config");

test("defaults work for local development", () => {
  const c = loadConfig({});
  assert.equal(c.ipfs.provider, "kubo");
  assert.equal(c.ipfs.apiUrl, "http://127.0.0.1:5001");
  assert.equal(c.maxUploadBytes, 101 * 1024 * 1024);
  assert.deepEqual(c.corsOrigins, ["http://localhost:5173", "http://127.0.0.1:5173"]);
});

test("reads values from the environment", () => {
  const c = loadConfig({ IPFS_API_URL: "https://ipfs.example.com/", IPFS_API_TOKEN: "t", MAX_UPLOAD_SIZE_MB: "5", PORT: "8080" });
  assert.equal(c.ipfs.apiUrl, "https://ipfs.example.com");
  assert.equal(c.ipfs.apiToken, "t");
  assert.equal(c.maxUploadBytes, 5 * 1024 * 1024);
  assert.equal(c.port, 8080);
});

test("fails fast with every problem listed", () => {
  assert.throws(
    () => loadConfig({ IPFS_PROVIDER: "pinata", IPFS_API_URL: "not a url", MAX_UPLOAD_SIZE_MB: "-3", CORS_ORIGIN: "*", IPFS_TIMEOUT_MS: "5" }),
    (err) => {
      assert.ok(err instanceof ConfigError);
      const text = err.problems.join("|");
      for (const needle of ["IPFS_PROVIDER", "IPFS_API_URL", "MAX_UPLOAD_SIZE_MB", "CORS_ORIGIN", "IPFS_TIMEOUT_MS"]) {
        assert.ok(text.includes(needle), needle);
      }
      return true;
    }
  );
});

test("rejects non-http API URLs and warns on remote plain http", () => {
  assert.throws(() => loadConfig({ IPFS_API_URL: "ftp://x" }), ConfigError);
  assert.equal(loadConfig({ IPFS_API_URL: "http://10.0.0.5:5001" }).warnings.length, 1);
  assert.equal(loadConfig({ IPFS_API_URL: "http://localhost:5001" }).warnings.length, 0);
});
