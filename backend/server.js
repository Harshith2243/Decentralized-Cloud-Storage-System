require("dotenv").config();
const { loadConfig, ConfigError } = require("./config");
const { createProvider } = require("./providers");
const { createApp } = require("./app");

let config;
try {
  config = loadConfig(process.env);
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}

const provider = createProvider(config);
const app = createApp({ config, provider });

app.listen(config.port, () => {
  console.log(`Backend listening on http://localhost:${config.port}`);
  // Origin only: never print tokens or credentials embedded in a URL.
  console.log(`Storage provider: ${provider.name} at ${new URL(config.ipfs.apiUrl).origin}`);
  for (const w of config.warnings) console.warn(`WARNING: ${w}`);
  provider.checkHealth().then(({ reachable }) => {
    console.log(reachable ? "Storage provider reachable." : "WARNING: storage provider is NOT reachable yet; uploads will fail with 503 until it is.");
  });
});
