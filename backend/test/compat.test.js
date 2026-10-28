// Proves the backend accepts containers produced by the REAL Phase 3 frontend
// crypto module, and that a full upload -> retrieve -> decrypt round trip works.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
const { pathToFileURL } = require("url");
const request = require("supertest");
const { createApp } = require("../app");
const { FakeProvider, testConfig, CID_V1 } = require("./helpers");

const cryptoPath = path.resolve(__dirname, "../../frontend/src/utils/crypto.js");
const available = fs.existsSync(cryptoPath);

test("Phase 3 containers pass backend validation and decrypt after retrieval", { skip: !available && "frontend not present" }, async () => {
  const fe = await import(pathToFileURL(cryptoPath).href);
  const secret = "TOP-SECRET plaintext marker 🔐";
  const file = new File([new TextEncoder().encode(secret)], "plan.txt", { type: "text/plain" });
  const { encryptedData, key, metadata } = await fe.encryptFile(file);
  const packed = Buffer.from(fe.packEncryptedFile(encryptedData, metadata));

  const provider = new FakeProvider();
  const app = createApp({ config: testConfig(), provider });

  const up = await request(app).post("/api/storage/upload").attach("file", packed, "encrypted.bin");
  assert.equal(up.status, 201);

  // What reached the provider: ciphertext only. No plaintext, no key.
  const stored = provider.uploads[0];
  assert.equal(stored.includes(Buffer.from(secret)), false);
  const exportedKey = await fe.exportEncryptionKey(key);
  assert.equal(stored.includes(Buffer.from(exportedKey)), false);
  assert.equal(stored.includes(Buffer.from(exportedKey, "base64")), false);

  const down = await request(app).get(`/api/storage/${up.body.cid}`).buffer(true).parse((r, cb) => {
    const parts = []; r.on("data", (d) => parts.push(d)); r.on("end", () => cb(null, Buffer.concat(parts)));
  });
  const parsed = fe.unpackEncryptedFile(new Uint8Array(down.body));
  const plain = await fe.decryptFile(parsed.encryptedData, key, parsed.iv);
  assert.equal(new TextDecoder().decode(plain), secret);
  assert.equal(up.body.cid, CID_V1);
});
