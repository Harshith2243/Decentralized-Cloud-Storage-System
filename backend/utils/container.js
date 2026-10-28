// Server-side validation of the Phase 3 encrypted container:
//   [8 bytes "DCSENC01"][4 bytes big-endian header length][header JSON][ciphertext]
// The backend ONLY stores bytes that parse as this format with a strict header
// allowlist, so plaintext files and key-bearing metadata are rejected.
const { HttpError } = require("./errors");

const MAGIC = Buffer.from("DCSENC01");
const MAX_HEADER_BYTES = 64 * 1024;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const ALGORITHM = "AES-256-GCM";
const ALLOWED_FIELDS = ["algorithm", "encryptedSize", "fileName", "iv", "mimeType", "originalSize"];

const invalid = (message) => new HttpError(422, "INVALID_CONTAINER", message);

/** Checks only the signature + header length (used while streaming retrieval). */
function hasContainerSignature(head) {
  if (!head || head.length < MAGIC.length + 4) return false;
  if (!head.subarray(0, MAGIC.length).equals(MAGIC)) return false;
  const headerLength = head.readUInt32BE(MAGIC.length);
  return headerLength > 0 && headerLength <= MAX_HEADER_BYTES;
}

function validateEncryptedContainer(buffer) {
  if (!Buffer.isBuffer(buffer) || !hasContainerSignature(buffer)) {
    throw invalid("Upload rejected: not an encrypted container produced by this application.");
  }
  const headerLength = buffer.readUInt32BE(MAGIC.length);
  const headerStart = MAGIC.length + 4;
  if (headerStart + headerLength > buffer.length) throw invalid("Encrypted container header is truncated.");

  let metadata;
  try {
    metadata = JSON.parse(buffer.subarray(headerStart, headerStart + headerLength).toString("utf8"));
  } catch {
    throw invalid("Encrypted container header is not valid JSON.");
  }
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw invalid("Encrypted container header must be an object.");
  }

  const keys = Object.keys(metadata).sort();
  if (keys.length !== ALLOWED_FIELDS.length || keys.some((k, i) => k !== ALLOWED_FIELDS[i])) {
    throw invalid("Encrypted container header has missing or unexpected fields.");
  }
  if (metadata.algorithm !== ALGORITHM) throw invalid("Unsupported encryption algorithm.");
  for (const field of ["fileName", "mimeType"]) {
    if (typeof metadata[field] !== "string" || metadata[field].length > 255) {
      throw invalid(`Header field ${field} is invalid.`);
    }
  }
  if (metadata.fileName.length === 0) throw invalid("Header field fileName is invalid.");
  for (const field of ["originalSize", "encryptedSize"]) {
    if (!Number.isSafeInteger(metadata[field]) || metadata[field] < 0) throw invalid(`Header field ${field} is invalid.`);
  }
  if (metadata.encryptedSize !== metadata.originalSize + TAG_LENGTH) throw invalid("Header sizes are inconsistent.");
  if (typeof metadata.iv !== "string" || !/^[A-Za-z0-9+/]{16}$/.test(metadata.iv) || Buffer.from(metadata.iv, "base64").length !== IV_LENGTH) {
    throw invalid("Header IV is invalid.");
  }
  if (buffer.length - headerStart - headerLength !== metadata.encryptedSize) {
    throw invalid("Encrypted payload length does not match the header.");
  }
  return metadata;
}

module.exports = { validateEncryptedContainer, hasContainerSignature };
