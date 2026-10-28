const crypto = require("crypto");
const { Readable } = require("stream");
const { IpfsProvider, ProviderError } = require("../providers/IpfsProvider");

// Build a structurally valid Phase 3 container (random bytes stand in for ciphertext).
function makeContainer({ plainSize = 40, headerOverrides = {}, fileName = "note.txt" } = {}) {
  const iv = crypto.randomBytes(12).toString("base64");
  const header = {
    fileName,
    mimeType: "text/plain",
    originalSize: plainSize,
    encryptedSize: plainSize + 16,
    algorithm: "AES-256-GCM",
    iv,
    ...headerOverrides,
  };
  const headerBytes = Buffer.from(JSON.stringify(header));
  const len = Buffer.alloc(4);
  len.writeUInt32BE(headerBytes.length);
  const cipherLen = headerOverrides.encryptedSize ?? plainSize + 16;
  return Buffer.concat([Buffer.from("DCSENC01"), len, headerBytes, crypto.randomBytes(cipherLen)]);
}

// A valid CIDv0 and CIDv1 (well-known from IPFS docs).
const CID_V0 = "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG";
const CID_V1 = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";

class FakeProvider extends IpfsProvider {
  constructor() {
    super();
    this.store = new Map();
    this.uploads = [];
    this.fail = null; // ProviderError code to throw
    this.healthy = true;
  }
  get name() {
    return "fake";
  }
  _maybeFail() {
    if (this.fail) throw new ProviderError(this.fail, "boom with secret-token-123");
  }
  async uploadEncryptedFile(buffer) {
    this._maybeFail();
    this.uploads.push(buffer);
    this.store.set(CID_V1, buffer);
    return { cid: CID_V1, size: buffer.length };
  }
  async retrieveEncryptedFile(cid) {
    this._maybeFail();
    const data = this.store.get(cid);
    if (!data) throw new ProviderError("NOT_FOUND", "nope");
    // deliver in small chunks to exercise streaming
    const chunks = [];
    for (let i = 0; i < data.length; i += 7) chunks.push(data.subarray(i, i + 7));
    return { stream: Readable.from(chunks) };
  }
  async getFileMetadata(cid) {
    this._maybeFail();
    const data = this.store.get(cid);
    if (!data) throw new ProviderError("NOT_FOUND", "nope");
    return { cid, size: data.length };
  }
  async checkHealth() {
    return { reachable: this.healthy };
  }
}

const testConfig = (over = {}) => ({
  port: 0,
  corsOrigins: ["http://localhost:5173"],
  rateLimitPerMinute: 10000,
  maxUploadBytes: 1024 * 1024,
  warnings: [],
  ipfs: { provider: "fake", apiUrl: "http://127.0.0.1:5001", apiToken: "secret-token-123", timeoutMs: 1000, retrieveTimeoutMs: 1000 },
  ...over,
});

module.exports = { makeContainer, FakeProvider, testConfig, CID_V0, CID_V1 };
