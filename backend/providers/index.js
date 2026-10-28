const { KuboProvider } = require("./KuboProvider");

function createProvider(config) {
  switch (config.ipfs.provider) {
    case "kubo":
      return new KuboProvider({
        apiUrl: config.ipfs.apiUrl,
        apiToken: config.ipfs.apiToken,
        timeoutMs: config.ipfs.timeoutMs,
        retrieveTimeoutMs: config.ipfs.retrieveTimeoutMs,
      });
    default:
      throw new Error(`Unsupported IPFS provider: ${config.ipfs.provider}`);
  }
}

module.exports = { createProvider };
