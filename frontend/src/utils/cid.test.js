import { describe, it, expect } from "vitest";
import { isValidCID } from "./cid";

const V0 = "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG";
const V1 = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";

describe("isValidCID", () => {
  it("accepts CIDv0 and CIDv1", () => {
    expect(isValidCID(V0)).toBe(true);
    expect(isValidCID(V1)).toBe(true);
  });

  it("rejects malformed and injection-style values", () => {
    const bad = ["", "abc", null, undefined, 42, V0.slice(0, -1), V0 + "a", V1.slice(0, -2), V1.toUpperCase(),
      "../../etc/passwd", "http://evil.example/" + V0, V0 + "/x", V1 + "?a=1", "Qm" + "0".repeat(44), "x".repeat(200)];
    for (const v of bad) expect(isValidCID(v), String(v)).toBe(false);
  });
});
