// Frontend storage client. The React UI depends only on this interface:
//   validateCID(cid) | uploadEncryptedFile(bytes, opts) | retrieveEncryptedFile(cid, opts)
//   | getFileMetadata(cid) | checkHealth()
// Swap `createBackendStorageProvider` for another implementation without touching components.
//
// This module only ever sends the ENCRYPTED container produced by crypto.js.
// It has no access to encryption keys or plaintext.
import { BACKEND_URL } from "../utils/constants";
import { isValidCID } from "../utils/cid";

export const MAX_DOWNLOAD_BYTES = 101 * 1024 * 1024; // matches the backend default upload cap

export class StorageError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = "StorageError";
    this.code = code;
    this.status = status;
  }
}

const FRIENDLY = {
  INVALID_CID: "That CID is not valid.",
  NOT_FOUND: "No content was found for that CID.",
  FILE_TOO_LARGE: "The encrypted file is larger than the server allows.",
  INVALID_CONTAINER: "The server rejected the file: it is not a valid encrypted container.",
  NOT_ENCRYPTED_CONTAINER: "That CID does not contain an encrypted file created by this application.",
  STORAGE_UNAVAILABLE: "The IPFS storage service is unavailable. Nothing was uploaded.",
  STORAGE_TIMEOUT: "The IPFS storage service timed out.",
  STORAGE_MISCONFIGURED: "The storage service is misconfigured on the server.",
  STORAGE_ERROR: "The storage service returned an unexpected response.",
  RATE_LIMITED: "Too many requests. Please wait a moment and try again.",
};

function errorFromResponse(status, bodyText) {
  let code;
  try {
    code = JSON.parse(bodyText)?.code;
  } catch {
    /* non-JSON error body */
  }
  const message = FRIENDLY[code] || `The server returned an error (HTTP ${status}).`;
  return new StorageError(code || "HTTP_ERROR", message, status);
}

export function createBackendStorageProvider({
  baseUrl = BACKEND_URL,
  xhrFactory = () => new XMLHttpRequest(),
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    name: "ipfs-via-backend",

    validateCID(cid) {
      return isValidCID(cid);
    },

    /**
     * Uploads encrypted container bytes. Resolves with { cid, size } ONLY after the
     * backend reports that the storage provider confirmed the upload (HTTP 201 + CID).
     */
    uploadEncryptedFile(bytes, { onProgress, signal } = {}) {
      return new Promise((resolve, reject) => {
        const xhr = xhrFactory();
        const form = new FormData();
        form.append("file", new Blob([bytes], { type: "application/octet-stream" }), "encrypted.bin");

        xhr.open("POST", `${baseUrl}/api/storage/upload`);
        xhr.timeout = 10 * 60 * 1000;
        if (xhr.upload) {
          xhr.upload.onprogress = (e) => {
            if (onProgress && e.lengthComputable) onProgress({ loaded: e.loaded, total: e.total });
          };
        }
        xhr.onload = () => {
          if (xhr.status === 201) {
            let data;
            try {
              data = JSON.parse(xhr.responseText);
            } catch {
              return reject(new StorageError("BAD_RESPONSE", "The server returned an unreadable response."));
            }
            if (!isValidCID(data?.cid)) {
              return reject(new StorageError("BAD_RESPONSE", "The server did not confirm the upload with a valid CID."));
            }
            return resolve({ cid: data.cid, size: data.size });
          }
          reject(errorFromResponse(xhr.status, xhr.responseText));
        };
        xhr.onerror = () => reject(new StorageError("NETWORK", "Could not reach the backend. Is it running?"));
        xhr.ontimeout = () => reject(new StorageError("TIMEOUT", "The upload timed out."));
        xhr.onabort = () => reject(new StorageError("ABORTED", "The upload was cancelled."));
        if (signal) {
          if (signal.aborted) return reject(new StorageError("ABORTED", "The upload was cancelled."));
          signal.addEventListener("abort", () => xhr.abort(), { once: true });
        }
        xhr.send(form);
      });
    },

    /** Downloads the encrypted container bytes for a CID. Resolves with a Uint8Array. */
    async retrieveEncryptedFile(cid, { onProgress, signal } = {}) {
      if (!isValidCID(cid)) throw new StorageError("INVALID_CID", FRIENDLY.INVALID_CID);

      let res;
      try {
        res = await fetchImpl(`${baseUrl}/api/storage/${encodeURIComponent(cid)}`, { signal });
      } catch (err) {
        if (err?.name === "AbortError") throw new StorageError("ABORTED", "The retrieval was cancelled.");
        throw new StorageError("NETWORK", "Could not reach the backend. Is it running?");
      }
      if (!res.ok) throw errorFromResponse(res.status, await res.text().catch(() => ""));

      const total = Number(res.headers.get("content-length")) || 0;
      if (total > MAX_DOWNLOAD_BYTES) throw new StorageError("FILE_TOO_LARGE", "The stored file is larger than this app supports.");

      try {
        const reader = res.body.getReader();
        const chunks = [];
        let loaded = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          loaded += value.length;
          if (loaded > MAX_DOWNLOAD_BYTES) {
            await reader.cancel();
            throw new StorageError("FILE_TOO_LARGE", "The stored file is larger than this app supports.");
          }
          chunks.push(value);
          if (onProgress) onProgress({ loaded, total });
        }
        const out = new Uint8Array(loaded);
        let offset = 0;
        for (const c of chunks) {
          out.set(c, offset);
          offset += c.length;
        }
        return out;
      } catch (err) {
        if (err instanceof StorageError) throw err;
        if (err?.name === "AbortError") throw new StorageError("ABORTED", "The retrieval was cancelled.");
        throw new StorageError("NETWORK", "The connection was interrupted while downloading.");
      }
    },

    async getFileMetadata(cid) {
      if (!isValidCID(cid)) throw new StorageError("INVALID_CID", FRIENDLY.INVALID_CID);
      const res = await fetchImpl(`${baseUrl}/api/storage/${encodeURIComponent(cid)}/info`).catch(() => {
        throw new StorageError("NETWORK", "Could not reach the backend. Is it running?");
      });
      if (!res.ok) throw errorFromResponse(res.status, await res.text().catch(() => ""));
      return res.json();
    },

    async checkHealth() {
      try {
        const res = await fetchImpl(`${baseUrl}/api/storage/health`);
        return { reachable: res.ok };
      } catch {
        return { reachable: false };
      }
    },
  };
}

export const storage = createBackendStorageProvider();
