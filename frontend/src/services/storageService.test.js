import { describe, it, expect, vi } from "vitest";
import { createBackendStorageProvider, StorageError } from "./storageService";
import { encryptFile, packEncryptedFile, unpackEncryptedFile, decryptFile, exportEncryptionKey } from "../utils/crypto";

const CID = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
const BASE = "http://backend.test";

// Minimal XMLHttpRequest stand-in that records what would be sent over the wire.
function makeXhr({ status = 201, responseText = JSON.stringify({ cid: CID, size: 1 }), fail = null, progress = null } = {}) {
  const xhr = {
    upload: {},
    sent: null,
    opened: null,
    open(method, url) { xhr.opened = { method, url }; },
    send(form) {
      xhr.sent = form;
      setTimeout(() => {
        if (progress) xhr.upload.onprogress({ lengthComputable: true, ...progress });
        if (fail === "network") return xhr.onerror();
        if (fail === "timeout") return xhr.ontimeout();
        xhr.status = status;
        xhr.responseText = responseText;
        xhr.onload();
      }, 0);
    },
    abort() { xhr.onabort(); },
  };
  return xhr;
}

const makeFile = (text, name = "secret-notes.txt") => new File([new TextEncoder().encode(text)], name, { type: "text/plain" });

describe("uploadEncryptedFile", () => {
  it("resolves with the CID only after a 201 confirmation, and reports progress", async () => {
    const xhr = makeXhr({ progress: { loaded: 5, total: 10 } });
    const storage = createBackendStorageProvider({ baseUrl: BASE, xhrFactory: () => xhr });
    const onProgress = vi.fn();
    const result = await storage.uploadEncryptedFile(new Uint8Array([1, 2, 3]), { onProgress });
    expect(result).toEqual({ cid: CID, size: 1 });
    expect(onProgress).toHaveBeenCalledWith({ loaded: 5, total: 10 });
    expect(xhr.opened).toEqual({ method: "POST", url: `${BASE}/api/storage/upload` });
  });

  it("never treats non-201 responses or a missing/invalid CID as success", async () => {
    const cases = [
      [makeXhr({ status: 200 }), /HTTP 200/],
      [makeXhr({ status: 201, responseText: JSON.stringify({ size: 1 }) }), /valid CID/],
      [makeXhr({ status: 201, responseText: JSON.stringify({ cid: "garbage" }) }), /valid CID/],
      [makeXhr({ status: 201, responseText: "<html>" }), /unreadable/],
    ];
    for (const [xhr, pattern] of cases) {
      const storage = createBackendStorageProvider({ baseUrl: BASE, xhrFactory: () => xhr });
      await expect(storage.uploadEncryptedFile(new Uint8Array(1))).rejects.toThrow(pattern);
    }
  });

  it("maps backend error codes to clear messages", async () => {
    const map = [
      [503, "STORAGE_UNAVAILABLE", /unavailable. Nothing was uploaded/],
      [504, "STORAGE_TIMEOUT", /timed out/],
      [413, "FILE_TOO_LARGE", /larger than the server allows/],
      [422, "INVALID_CONTAINER", /not a valid encrypted container/],
      [429, "RATE_LIMITED", /Too many requests/],
    ];
    for (const [status, code, pattern] of map) {
      const xhr = makeXhr({ status, responseText: JSON.stringify({ error: "x", code }) });
      const storage = createBackendStorageProvider({ baseUrl: BASE, xhrFactory: () => xhr });
      const err = await storage.uploadEncryptedFile(new Uint8Array(1)).catch((e) => e);
      expect(err).toBeInstanceOf(StorageError);
      expect(err.code).toBe(code);
      expect(err.message).toMatch(pattern);
    }
  });

  it("reports network failures and timeouts", async () => {
    for (const [fail, pattern] of [["network", /Could not reach the backend/], ["timeout", /timed out/]]) {
      const storage = createBackendStorageProvider({ baseUrl: BASE, xhrFactory: () => makeXhr({ fail }) });
      await expect(storage.uploadEncryptedFile(new Uint8Array(1))).rejects.toThrow(pattern);
    }
  });

  it("sends ONLY the encrypted container: no plaintext, no key", async () => {
    const secret = "TOP-SECRET-PLAINTEXT-MARKER";
    const { encryptedData, key, metadata } = await encryptFile(makeFile(secret));
    const packed = packEncryptedFile(encryptedData, metadata);
    const xhr = makeXhr();
    const storage = createBackendStorageProvider({ baseUrl: BASE, xhrFactory: () => xhr });
    await storage.uploadEncryptedFile(packed);

    const form = xhr.sent;
    expect([...form.keys()]).toEqual(["file"]); // one field, nothing else (no key field)
    const sentBytes = new Uint8Array(await form.get("file").arrayBuffer());
    expect(Array.from(sentBytes)).toEqual(Array.from(packed));

    const latin1 = Buffer.from(sentBytes).toString("latin1");
    expect(latin1.includes(secret)).toBe(false);
    const exportedKey = await exportEncryptionKey(key);
    expect(latin1.includes(exportedKey)).toBe(false);
    expect(Buffer.from(sentBytes).includes(Buffer.from(exportedKey, "base64"))).toBe(false);
  });
});

describe("retrieveEncryptedFile", () => {
  const streamOf = (bytes, size = 4) => new ReadableStream({
    start(c) { for (let i = 0; i < bytes.length; i += size) c.enqueue(bytes.slice(i, i + size)); c.close(); },
  });
  const okResponse = (bytes) => new Response(streamOf(bytes), { status: 200, headers: { "content-length": String(bytes.length) } });

  it("rejects an invalid CID without any network call", async () => {
    const fetchImpl = vi.fn();
    const storage = createBackendStorageProvider({ baseUrl: BASE, fetchImpl });
    await expect(storage.retrieveEncryptedFile("not-a-cid")).rejects.toMatchObject({ code: "INVALID_CID" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("downloads bytes with progress", async () => {
    const bytes = new Uint8Array(20).map((_, i) => i);
    const fetchImpl = vi.fn(async () => okResponse(bytes));
    const onProgress = vi.fn();
    const out = await createBackendStorageProvider({ baseUrl: BASE, fetchImpl }).retrieveEncryptedFile(CID, { onProgress });
    expect(Array.from(out)).toEqual(Array.from(bytes));
    expect(fetchImpl.mock.calls[0][0]).toBe(`${BASE}/api/storage/${CID}`);
    expect(onProgress).toHaveBeenLastCalledWith({ loaded: 20, total: 20 });
  });

  it("maps 404 / 503 / 422 / network errors", async () => {
    const cases = [
      [() => new Response(JSON.stringify({ code: "NOT_FOUND" }), { status: 404 }), /No content was found/],
      [() => new Response(JSON.stringify({ code: "STORAGE_UNAVAILABLE" }), { status: 503 }), /unavailable/],
      [() => new Response(JSON.stringify({ code: "NOT_ENCRYPTED_CONTAINER" }), { status: 422 }), /does not contain an encrypted file/],
      [() => { throw new TypeError("fetch failed"); }, /Could not reach the backend/],
    ];
    for (const [impl, pattern] of cases) {
      const storage = createBackendStorageProvider({ baseUrl: BASE, fetchImpl: async () => impl() });
      await expect(storage.retrieveEncryptedFile(CID)).rejects.toThrow(pattern);
    }
  });

  it("aborts oversized downloads", async () => {
    const big = new Response(streamOf(new Uint8Array(10)), { status: 200, headers: { "content-length": String(500 * 1024 * 1024) } });
    const storage = createBackendStorageProvider({ baseUrl: BASE, fetchImpl: async () => big });
    await expect(storage.retrieveEncryptedFile(CID)).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
  });
});

describe("encryption compatibility (Phase 3 <-> Phase 4)", () => {
  it("bytes stored via upload and retrieved again decrypt with the existing decryptFile", async () => {
    const text = "round trip through storage ✓ नमस्ते";
    const { encryptedData, key, metadata } = await encryptFile(makeFile(text));
    const packed = packEncryptedFile(encryptedData, metadata);

    // Fake "backend + IPFS": stores whatever the upload sends, serves it back.
    let stored = null;
    const xhrFactory = () => {
      const xhr = makeXhr();
      const send = xhr.send;
      xhr.send = async (form) => { stored = new Uint8Array(await form.get("file").arrayBuffer()); send(form); };
      return xhr;
    };
    const fetchImpl = async () => new Response(stored, { status: 200, headers: { "content-length": String(stored.length) } });
    const storage = createBackendStorageProvider({ baseUrl: BASE, xhrFactory, fetchImpl });

    const { cid } = await storage.uploadEncryptedFile(packed);
    const retrieved = await storage.retrieveEncryptedFile(cid);
    const parsed = unpackEncryptedFile(retrieved);
    const plain = await decryptFile(parsed.encryptedData, key, parsed.iv);
    expect(new TextDecoder().decode(plain)).toBe(text);
  });

  it("a tampered retrieved container fails authentication", async () => {
    const { encryptedData, key, metadata } = await encryptFile(makeFile("tamper me"));
    const packed = packEncryptedFile(encryptedData, metadata);
    packed[packed.length - 5] ^= 1;
    const parsed = unpackEncryptedFile(packed);
    await expect(decryptFile(parsed.encryptedData, key, parsed.iv)).rejects.toThrow(/Decryption failed/);
  });
});
