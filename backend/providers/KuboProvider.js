// Provider for a Kubo (go-ipfs) node using its documented HTTP RPC API
// (/api/v0/add, /cat, /files/stat, /id). Works for a local dev node
// (http://127.0.0.1:5001) or any Kubo RPC endpoint reachable by this backend.
//
// Persistence: `add` with pin=true pins the data on THAT node only. It stays
// available while the node runs and keeps the pin; nothing here replicates it
// to other nodes or guarantees permanence.
const { Readable } = require("stream");
const { IpfsProvider, ProviderError } = require("./IpfsProvider");

const FILE_PART_NAME = "encrypted.bin"; // generic name: never leak the original filename to IPFS

class KuboProvider extends IpfsProvider {
  constructor({ apiUrl, apiToken = "", timeoutMs = 30000, retrieveTimeoutMs = 120000, fetchImpl = globalThis.fetch }) {
    super();
    this.apiUrl = apiUrl.replace(/\/+$/, "");
    this.apiToken = apiToken;
    this.timeoutMs = timeoutMs;
    this.retrieveTimeoutMs = retrieveTimeoutMs;
    this.fetch = fetchImpl;
  }

  get name() {
    return "kubo";
  }

  _headers() {
    return this.apiToken ? { Authorization: `Bearer ${this.apiToken}` } : {};
  }

  async _call(path, { query = {}, body, timeoutMs = this.timeoutMs } = {}) {
    const url = new URL(`${this.apiUrl}/api/v0/${path}`);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));

    let res;
    try {
      res = await this.fetch(url, {
        method: "POST", // Kubo RPC requires POST
        headers: this._headers(),
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if (err?.name === "TimeoutError" || err?.name === "AbortError") {
        throw new ProviderError("TIMEOUT", "The storage provider did not respond in time.");
      }
      throw new ProviderError("UNAVAILABLE", "The storage provider is unreachable.");
    }

    if (!res.ok) {
      let detail = "";
      try {
        detail = (await res.text()).slice(0, 500);
      } catch {
        /* ignore */
      }
      if (res.status === 401 || res.status === 403) {
        throw new ProviderError("AUTH", "The storage provider rejected the backend's credentials.");
      }
      if (/not found|no link named|could not resolve/i.test(detail)) {
        throw new ProviderError("NOT_FOUND", "Content not found on the storage provider.");
      }
      throw new ProviderError("BAD_RESPONSE", `The storage provider returned HTTP ${res.status}.`);
    }
    return res;
  }

  async uploadEncryptedFile(buffer) {
    const form = new FormData();
    form.append("file", new Blob([buffer], { type: "application/octet-stream" }), FILE_PART_NAME);

    const res = await this._call("add", {
      query: { pin: "true", "cid-version": "1", quieter: "false" },
      body: form,
    });

    let text;
    try {
      text = await res.text();
    } catch {
      throw new ProviderError("UNAVAILABLE", "The storage provider connection dropped during upload.");
    }
    // Kubo answers with newline-delimited JSON; the last entry is the root.
    let cid = null;
    for (const line of text.split("\n").filter(Boolean)) {
      try {
        const entry = JSON.parse(line);
        if (entry && typeof entry.Hash === "string") cid = entry.Hash;
      } catch {
        /* skip non-JSON lines */
      }
    }
    if (!cid || !this.validateCID(cid)) {
      throw new ProviderError("BAD_RESPONSE", "The storage provider did not confirm the upload with a valid CID.");
    }
    return { cid, size: buffer.length };
  }

  async retrieveEncryptedFile(cid) {
    const res = await this._call("cat", { query: { arg: cid }, timeoutMs: this.retrieveTimeoutMs });
    if (!res.body) throw new ProviderError("BAD_RESPONSE", "The storage provider returned no content.");
    return { stream: Readable.fromWeb(res.body) };
  }

  async getFileMetadata(cid) {
    const res = await this._call("files/stat", { query: { arg: `/ipfs/${cid}` } });
    let data;
    try {
      data = await res.json();
    } catch {
      throw new ProviderError("BAD_RESPONSE", "The storage provider returned unreadable metadata.");
    }
    if (!Number.isFinite(data?.Size)) throw new ProviderError("BAD_RESPONSE", "The storage provider returned unreadable metadata.");
    return { cid, size: data.Size };
  }

  async checkHealth() {
    try {
      const res = await this._call("id", { timeoutMs: Math.min(this.timeoutMs, 5000) });
      await res.arrayBuffer();
      return { reachable: true };
    } catch {
      return { reachable: false };
    }
  }
}

module.exports = { KuboProvider };
