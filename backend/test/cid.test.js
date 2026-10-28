const test = require("node:test");
const assert = require("node:assert/strict");
const { isValidCID } = require("../utils/cid");
const { CID_V0, CID_V1 } = require("./helpers");

test("accepts well-known CIDv0 and CIDv1", () => {
  assert.equal(isValidCID(CID_V0), true);
  assert.equal(isValidCID(CID_V1), true);
});

test("agrees with the multiformats reference implementation", async () => {
  const { CID } = await import("multiformats/cid");
  const { sha256 } = await import("multiformats/hashes/sha2");
  for (let i = 0; i < 20; i++) {
    const digest = await sha256.digest(Buffer.from(`sample-${i}`));
    const v1raw = CID.create(1, 0x55, digest).toString();
    const v1pb = CID.create(1, 0x70, digest).toString();
    const v0 = CID.create(0, 0x70, digest).toString();
    for (const c of [v1raw, v1pb, v0]) assert.equal(isValidCID(c), true, c);
  }
});

test("rejects malformed, tampered and injection-style values", () => {
  const bad = [
    "", "abc", null, undefined, 123, {}, [],
    CID_V0.slice(0, -1), CID_V0 + "a", CID_V0.replace("Qm", "Zz"),
    CID_V1.slice(0, -2), CID_V1.toUpperCase(), CID_V1 + "?x=1",
    "../../etc/passwd", "http://evil.example/" + CID_V0, CID_V0 + "/../../x", `${CID_V0}\n`,
    "Qm" + "0".repeat(44), "b" + "a".repeat(58), "x".repeat(200),
  ];
  for (const v of bad) assert.equal(isValidCID(v), false, String(v));
});
