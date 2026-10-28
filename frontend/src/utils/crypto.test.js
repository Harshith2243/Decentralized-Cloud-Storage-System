import { describe, it, expect } from "vitest";
import {
  generateEncryptionKey,
  encryptFile,
  decryptFile,
  exportEncryptionKey,
  importEncryptionKey,
  packEncryptedFile,
  unpackEncryptedFile,
  validateMetadata,
  validateFileSelection,
  IV_LENGTH,
  TAG_LENGTH,
} from "./crypto";

const makeFile = (bytes, name = "test.bin", type = "application/octet-stream") =>
  new File([bytes], name, { type });

const bytesOf = (buf) => Array.from(new Uint8Array(buf));

describe("AES-256-GCM encryption", () => {
  it("encrypts and decrypts, restoring the exact original bytes", async () => {
    const original = new TextEncoder().encode("hello decentralized world");
    const { encryptedData, iv, key } = await encryptFile(makeFile(original, "a.txt", "text/plain"));
    const plain = await decryptFile(encryptedData, key, iv);
    expect(bytesOf(plain)).toEqual(Array.from(original));
  });

  it("produces ciphertext that differs from plaintext and is original + 16 bytes", async () => {
    const original = new Uint8Array(1000).fill(65);
    const { encryptedData } = await encryptFile(makeFile(original));
    expect(encryptedData.byteLength).toBe(1000 + TAG_LENGTH);
    expect(bytesOf(encryptedData).slice(0, 1000)).not.toEqual(Array.from(original));
  });

  it("handles an empty file", async () => {
    const { encryptedData, iv, key, metadata } = await encryptFile(makeFile(new Uint8Array(0), "empty.txt"));
    expect(metadata.originalSize).toBe(0);
    expect(encryptedData.byteLength).toBe(TAG_LENGTH);
    const plain = await decryptFile(encryptedData, key, iv);
    expect(plain.byteLength).toBe(0);
  });

  it("handles binary data covering every byte value", async () => {
    const original = new Uint8Array(256 * 8).map((_, i) => i % 256);
    const { encryptedData, iv, key } = await encryptFile(makeFile(original, "all-bytes.bin"));
    expect(bytesOf(await decryptFile(encryptedData, key, iv))).toEqual(Array.from(original));
  });

  it("handles UTF-8 text with multi-byte characters", async () => {
    const text = "नमस्ते — héllo — 你好 — 🔐";
    const original = new TextEncoder().encode(text);
    const { encryptedData, iv, key } = await encryptFile(makeFile(original, "u.txt", "text/plain"));
    const plain = await decryptFile(encryptedData, key, iv);
    expect(new TextDecoder().decode(plain)).toBe(text);
  });

  it("uses a different IV and key for every encryption of the same file", async () => {
    const file = makeFile(new Uint8Array([1, 2, 3]));
    const a = await encryptFile(file);
    const b = await encryptFile(file);
    expect(a.metadata.iv).not.toBe(b.metadata.iv);
    expect(a.iv.length).toBe(IV_LENGTH);
    expect(await exportEncryptionKey(a.key)).not.toBe(await exportEncryptionKey(b.key));
    expect(bytesOf(a.encryptedData)).not.toEqual(bytesOf(b.encryptedData));
  });

  it("records the required metadata and no key material", async () => {
    const { metadata } = await encryptFile(makeFile(new Uint8Array(10), "doc.pdf", "application/pdf"));
    expect(metadata).toMatchObject({
      fileName: "doc.pdf",
      mimeType: "application/pdf",
      originalSize: 10,
      encryptedSize: 10 + TAG_LENGTH,
      algorithm: "AES-256-GCM",
    });
    expect(Object.keys(metadata).sort()).toEqual(
      ["algorithm", "encryptedSize", "fileName", "iv", "mimeType", "originalSize"].sort()
    );
  });
});

describe("authentication failures", () => {
  it("fails to decrypt with the wrong key", async () => {
    const { encryptedData, iv } = await encryptFile(makeFile(new Uint8Array([9, 9, 9])));
    const wrongKey = await generateEncryptionKey();
    await expect(decryptFile(encryptedData, wrongKey, iv)).rejects.toThrow(/Decryption failed/);
  });

  it("fails when any ciphertext byte is modified", async () => {
    const { encryptedData, iv, key } = await encryptFile(makeFile(new Uint8Array(64).fill(7)));
    const tampered = new Uint8Array(encryptedData.slice(0));
    tampered[5] ^= 0x01;
    await expect(decryptFile(tampered.buffer, key, iv)).rejects.toThrow(/Decryption failed/);
  });

  it("fails when the authentication tag is modified", async () => {
    const { encryptedData, iv, key } = await encryptFile(makeFile(new Uint8Array(64).fill(7)));
    const tampered = new Uint8Array(encryptedData.slice(0));
    tampered[tampered.length - 1] ^= 0xff;
    await expect(decryptFile(tampered.buffer, key, iv)).rejects.toThrow(/Decryption failed/);
  });

  it("fails when the data is truncated", async () => {
    const { encryptedData, iv, key } = await encryptFile(makeFile(new Uint8Array(64).fill(7)));
    await expect(decryptFile(encryptedData.slice(0, 30), key, iv)).rejects.toThrow(/Decryption failed/);
  });

  it("fails with the wrong IV", async () => {
    const { encryptedData, key } = await encryptFile(makeFile(new Uint8Array(32).fill(3)));
    await expect(decryptFile(encryptedData, key, new Uint8Array(IV_LENGTH))).rejects.toThrow(/Decryption failed/);
  });

  it("rejects an IV of the wrong length", async () => {
    const { encryptedData, key } = await encryptFile(makeFile(new Uint8Array(4)));
    await expect(decryptFile(encryptedData, key, new Uint8Array(8))).rejects.toThrow(/Invalid IV/);
  });
});

describe("key export / import", () => {
  it("round-trips a key through export and import", async () => {
    const original = new TextEncoder().encode("key roundtrip");
    const { encryptedData, iv, key } = await encryptFile(makeFile(original));
    const restored = await importEncryptionKey(await exportEncryptionKey(key));
    expect(bytesOf(await decryptFile(encryptedData, restored, iv))).toEqual(Array.from(original));
  });

  it("exports a 32-byte (256-bit) key", async () => {
    const exported = await exportEncryptionKey(await generateEncryptionKey());
    expect(atob(exported).length).toBe(32);
  });

  it("rejects keys of the wrong length or malformed base64", async () => {
    await expect(importEncryptionKey(btoa("too short"))).rejects.toThrow(/32 bytes/);
    await expect(importEncryptionKey("%%%not-base64%%%")).rejects.toThrow(/Invalid base64/);
  });
});

describe("metadata validation", () => {
  const valid = () => ({
    fileName: "a.txt",
    mimeType: "text/plain",
    originalSize: 5,
    encryptedSize: 5 + TAG_LENGTH,
    algorithm: "AES-256-GCM",
    iv: btoa(String.fromCharCode(...new Uint8Array(IV_LENGTH))),
  });

  it("accepts valid metadata", () => {
    expect(() => validateMetadata(valid())).not.toThrow();
  });

  it.each([
    ["null metadata", () => null],
    ["wrong algorithm", () => ({ ...valid(), algorithm: "AES-128-CBC" })],
    ["missing fileName", () => ({ ...valid(), fileName: "" })],
    ["missing mimeType", () => ({ ...valid(), mimeType: undefined })],
    ["negative size", () => ({ ...valid(), originalSize: -1 })],
    ["non-integer size", () => ({ ...valid(), originalSize: 1.5 })],
    ["inconsistent sizes", () => ({ ...valid(), encryptedSize: 999 })],
    ["IV not base64", () => ({ ...valid(), iv: "!!!" })],
    ["IV wrong length", () => ({ ...valid(), iv: btoa("short") })],
    ["IV missing", () => ({ ...valid(), iv: undefined })],
  ])("rejects %s", (_name, build) => {
    expect(() => validateMetadata(build())).toThrow(/Invalid encryption metadata/);
  });
});

describe("packed encrypted file container", () => {
  it("packs and unpacks, then decrypts to the original bytes", async () => {
    const original = new TextEncoder().encode("container roundtrip ✓");
    const { encryptedData, key, metadata } = await encryptFile(makeFile(original, "c.txt", "text/plain"));
    const packed = packEncryptedFile(encryptedData, metadata);
    const parsed = unpackEncryptedFile(packed);
    expect(parsed.metadata).toEqual(metadata);
    expect(bytesOf(await decryptFile(parsed.encryptedData, key, parsed.iv))).toEqual(Array.from(original));
  });

  it("does not contain the key anywhere in the packed bytes", async () => {
    const { encryptedData, key, metadata } = await encryptFile(makeFile(new Uint8Array(100).fill(1)));
    const packed = packEncryptedFile(encryptedData, metadata);
    const keyBytes = Array.from(atob(await exportEncryptionKey(key)), (c) => c.charCodeAt(0));
    const hay = Array.from(packed).join(",");
    expect(hay.includes(keyBytes.join(","))).toBe(false);
  });

  it("rejects files with a bad signature, truncation, or corrupt header", async () => {
    const { encryptedData, metadata } = await encryptFile(makeFile(new Uint8Array(20)));
    const packed = packEncryptedFile(encryptedData, metadata);

    const badMagic = packed.slice();
    badMagic[0] ^= 0xff;
    expect(() => unpackEncryptedFile(badMagic)).toThrow(/bad signature/);

    expect(() => unpackEncryptedFile(packed.slice(0, packed.length - 3))).toThrow(/truncated/);
    expect(() => unpackEncryptedFile(new Uint8Array(5))).toThrow(/Not a valid encrypted file/);

    const badHeader = packed.slice();
    badHeader[8 + 4 + 2] = 0x7f; // corrupt a byte inside the JSON header
    expect(() => unpackEncryptedFile(badHeader)).toThrow();
  });

  it("detects ciphertext tampering after unpacking", async () => {
    const { encryptedData, key, metadata } = await encryptFile(makeFile(new Uint8Array(50).fill(2)));
    const packed = packEncryptedFile(encryptedData, metadata);
    packed[packed.length - 20] ^= 0x01; // flip a bit inside the ciphertext
    const parsed = unpackEncryptedFile(packed);
    await expect(decryptFile(parsed.encryptedData, key, parsed.iv)).rejects.toThrow(/Decryption failed/);
  });
});

describe("file selection validation", () => {
  it("rejects missing and empty files, accepts normal files", () => {
    expect(validateFileSelection(null)).toMatch(/select a file/);
    expect(validateFileSelection(makeFile(new Uint8Array(0)))).toMatch(/empty/);
    expect(validateFileSelection(makeFile(new Uint8Array(3)))).toBeNull();
  });

  it("rejects files over the size limit", () => {
    const huge = { size: 101 * 1024 * 1024 };
    expect(validateFileSelection(huge)).toMatch(/too large/);
  });
});
