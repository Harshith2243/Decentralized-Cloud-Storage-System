// Client-side file encryption using the Web Crypto API (AES-256-GCM).
//
// Security notes:
// - Keys and IVs come only from crypto.subtle / crypto.getRandomValues.
// - This module never logs keys or file contents, and never touches the network.
// - A fresh random key AND a fresh random 12-byte IV are generated per file.
// - AES-GCM is authenticated: wrong key or modified ciphertext => decryption throws.

export const ALGORITHM = "AES-256-GCM";
export const IV_LENGTH = 12; // bytes (96-bit IV, the recommended size for GCM)
export const TAG_LENGTH = 16; // bytes (128-bit auth tag appended to ciphertext)
export const KEY_LENGTH_BITS = 256;
export const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100 MB: Web Crypto encrypts in one shot, in memory

// Container format for a downloadable encrypted file:
//   [8 bytes magic "DCSENC01"] [4 bytes big-endian header length] [header JSON] [ciphertext]
const MAGIC = new TextEncoder().encode("DCSENC01");
const MAX_HEADER_BYTES = 64 * 1024;

function getSubtle() {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error(
      "Web Crypto is unavailable. Use a modern browser over HTTPS or http://localhost."
    );
  }
  return subtle;
}

// ---------- base64 helpers (no external deps) ----------

export function bytesToBase64(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < arr.length; i += chunk) {
    binary += String.fromCharCode(...arr.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64ToBytes(base64) {
  if (typeof base64 !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
    throw new Error("Invalid base64 data.");
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ---------- keys ----------

/** Generates a random 256-bit AES-GCM key. Extractable so it can be exported later. */
export async function generateEncryptionKey() {
  return getSubtle().generateKey({ name: "AES-GCM", length: KEY_LENGTH_BITS }, true, [
    "encrypt",
    "decrypt",
  ]);
}

/** Exports a key as a base64 string of its 32 raw bytes. Treat the result as a secret. */
export async function exportEncryptionKey(encryptionKey) {
  const raw = await getSubtle().exportKey("raw", encryptionKey);
  return bytesToBase64(new Uint8Array(raw));
}

/** Imports a key previously produced by exportEncryptionKey. */
export async function importEncryptionKey(exportedKey) {
  const raw = base64ToBytes(exportedKey);
  if (raw.length !== KEY_LENGTH_BITS / 8) {
    throw new Error("Invalid encryption key: expected 32 bytes (256 bits).");
  }
  return getSubtle().importKey("raw", raw, { name: "AES-GCM" }, true, ["encrypt", "decrypt"]);
}

// ---------- metadata ----------

/** Throws if metadata is malformed. Returns the metadata unchanged when valid. */
export function validateMetadata(metadata) {
  if (!metadata || typeof metadata !== "object") {
    throw new Error("Invalid encryption metadata: missing or not an object.");
  }
  if (metadata.algorithm !== ALGORITHM) {
    throw new Error(`Invalid encryption metadata: unsupported algorithm "${metadata.algorithm}".`);
  }
  if (typeof metadata.fileName !== "string" || metadata.fileName.length === 0) {
    throw new Error("Invalid encryption metadata: fileName is missing.");
  }
  if (typeof metadata.mimeType !== "string") {
    throw new Error("Invalid encryption metadata: mimeType is missing.");
  }
  for (const field of ["originalSize", "encryptedSize"]) {
    if (!Number.isSafeInteger(metadata[field]) || metadata[field] < 0) {
      throw new Error(`Invalid encryption metadata: ${field} must be a non-negative integer.`);
    }
  }
  if (metadata.encryptedSize !== metadata.originalSize + TAG_LENGTH) {
    throw new Error("Invalid encryption metadata: sizes are inconsistent.");
  }
  let iv;
  try {
    iv = base64ToBytes(metadata.iv);
  } catch {
    throw new Error("Invalid encryption metadata: IV is not valid base64.");
  }
  if (iv.length !== IV_LENGTH) {
    throw new Error(`Invalid encryption metadata: IV must be ${IV_LENGTH} bytes.`);
  }
  return metadata;
}

// ---------- encrypt / decrypt ----------

/**
 * Encrypts a File/Blob in the browser.
 * Returns { encryptedData: ArrayBuffer, iv: Uint8Array, key: CryptoKey, metadata }.
 * Only metadata (no key) is safe to store alongside the ciphertext.
 */
export async function encryptFile(file) {
  if (!file || typeof file.arrayBuffer !== "function") {
    throw new Error("encryptFile expects a File or Blob.");
  }
  if (file.size > MAX_FILE_SIZE) {
    throw new Error(`File is too large. Maximum supported size is ${MAX_FILE_SIZE / 1024 / 1024} MB.`);
  }

  const subtle = getSubtle();
  const key = await generateEncryptionKey();
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_LENGTH)); // fresh IV every call
  const plaintext = await file.arrayBuffer();
  const encryptedData = await subtle.encrypt({ name: "AES-GCM", iv, tagLength: TAG_LENGTH * 8 }, key, plaintext);

  const metadata = {
    fileName: file.name || "unnamed",
    mimeType: file.type || "application/octet-stream",
    originalSize: plaintext.byteLength,
    encryptedSize: encryptedData.byteLength,
    algorithm: ALGORITHM,
    iv: bytesToBase64(iv),
  };

  return { encryptedData, iv, key, metadata };
}

/**
 * Decrypts AES-GCM ciphertext. Throws if the key is wrong or the data was modified.
 * Returns the plaintext as an ArrayBuffer.
 */
export async function decryptFile(encryptedData, encryptionKey, iv) {
  if (!(iv instanceof Uint8Array) || iv.length !== IV_LENGTH) {
    throw new Error(`Invalid IV: expected ${IV_LENGTH} bytes.`);
  }
  try {
    return await getSubtle().decrypt(
      { name: "AES-GCM", iv, tagLength: TAG_LENGTH * 8 },
      encryptionKey,
      encryptedData
    );
  } catch {
    // Deliberately generic: do not leak details about why authentication failed.
    throw new Error("Decryption failed: wrong key or the encrypted data was modified.");
  }
}

// ---------- container (ciphertext + metadata in one downloadable file) ----------

/** Packs ciphertext and public metadata into one Uint8Array. Contains NO key. */
export function packEncryptedFile(encryptedData, metadata) {
  validateMetadata(metadata);
  const cipher = new Uint8Array(encryptedData);
  if (cipher.length !== metadata.encryptedSize) {
    throw new Error("Encrypted data length does not match metadata.");
  }
  const header = new TextEncoder().encode(JSON.stringify(metadata));
  const out = new Uint8Array(MAGIC.length + 4 + header.length + cipher.length);
  out.set(MAGIC, 0);
  new DataView(out.buffer).setUint32(MAGIC.length, header.length, false);
  out.set(header, MAGIC.length + 4);
  out.set(cipher, MAGIC.length + 4 + header.length);
  return out;
}

/** Parses a packed encrypted file. Returns { encryptedData: ArrayBuffer, metadata, iv }. */
export function unpackEncryptedFile(packed) {
  const bytes = packed instanceof Uint8Array ? packed : new Uint8Array(packed);
  if (bytes.length < MAGIC.length + 4 || !MAGIC.every((b, i) => bytes[i] === b)) {
    throw new Error("Not a valid encrypted file (bad signature).");
  }
  const headerLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
    MAGIC.length,
    false
  );
  const headerStart = MAGIC.length + 4;
  if (headerLength === 0 || headerLength > MAX_HEADER_BYTES || headerStart + headerLength > bytes.length) {
    throw new Error("Not a valid encrypted file (bad header length).");
  }
  let metadata;
  try {
    metadata = JSON.parse(new TextDecoder().decode(bytes.subarray(headerStart, headerStart + headerLength)));
  } catch {
    throw new Error("Not a valid encrypted file (unreadable header).");
  }
  validateMetadata(metadata);
  const cipher = bytes.slice(headerStart + headerLength);
  if (cipher.length !== metadata.encryptedSize) {
    throw new Error("Encrypted file is truncated or has extra data.");
  }
  return { encryptedData: cipher.buffer, metadata, iv: base64ToBytes(metadata.iv) };
}

// ---------- UI validation ----------

/** Returns an error message string for an unusable selection, or null if OK. */
export function validateFileSelection(file) {
  if (!file) return "Please select a file first.";
  if (file.size === 0) return "This file is empty. Choose a file with content.";
  if (file.size > MAX_FILE_SIZE) {
    return `File is too large. Maximum supported size is ${MAX_FILE_SIZE / 1024 / 1024} MB.`;
  }
  return null;
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}
