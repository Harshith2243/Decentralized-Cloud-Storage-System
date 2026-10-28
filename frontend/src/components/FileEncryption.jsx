import { useEffect, useRef, useState } from "react";
import {
  encryptFile,
  decryptFile,
  packEncryptedFile,
  unpackEncryptedFile,
  validateFileSelection,
  formatBytes,
} from "../utils/crypto";
import IpfsStoragePanel from "./IpfsStoragePanel";

// Phase 3: local encryption/decryption test. Encryption and decryption themselves
// never touch the network. Phase 4 adds <IpfsStoragePanel/>, which uploads only the
// ENCRYPTED container to IPFS via the backend. The blockchain is not involved yet.
//
// The encryption key lives ONLY in this component's React state (memory).
// It is never written to localStorage/sessionStorage, never logged, and is
// lost on refresh or when the tab closes.

async function sha256Hex(buffer) {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function FileEncryption({ storage, contract, account, isWrongNetwork, contractError }) {
  const [file, setFile] = useState(null);
  const [selectionError, setSelectionError] = useState(null);
  const [busy, setBusy] = useState(null); // null | "encrypting" | "decrypting"
  const [panelBusy, setPanelBusy] = useState(false); // IPFS upload/retrieval in progress
  const [error, setError] = useState(null);

  // Session-only secrets/results. `key` is a non-persisted CryptoKey.
  const [key, setKey] = useState(null);
  const [encrypted, setEncrypted] = useState(null); // { packed: Uint8Array, metadata }
  const [decrypted, setDecrypted] = useState(null); // { bytes: ArrayBuffer, verified: boolean }

  const [encryptedUrl, setEncryptedUrl] = useState(null);
  const [decryptedUrl, setDecryptedUrl] = useState(null);
  const urlsRef = useRef({ encryptedUrl: null, decryptedUrl: null });
  urlsRef.current = { encryptedUrl, decryptedUrl };

  // Revoke any outstanding object URLs on unmount.
  useEffect(() => {
    return () => {
      const { encryptedUrl: e, decryptedUrl: d } = urlsRef.current;
      if (e) URL.revokeObjectURL(e);
      if (d) URL.revokeObjectURL(d);
    };
  }, []);

  function replaceUrl(setter, blob) {
    setter((previous) => {
      if (previous) URL.revokeObjectURL(previous);
      return blob ? URL.createObjectURL(blob) : null;
    });
  }

  function resetResults() {
    setKey(null);
    setEncrypted(null);
    setDecrypted(null);
    replaceUrl(setEncryptedUrl, null);
    replaceUrl(setDecryptedUrl, null);
    setError(null);
  }

  function handleFileChange(event) {
    const selected = event.target.files?.[0] || null;
    resetResults(); // a new file means the old in-memory key/results no longer apply
    setFile(selected);
    setSelectionError(selected ? validateFileSelection(selected) : null);
  }

  async function handleEncrypt() {
    const problem = validateFileSelection(file);
    if (problem) {
      setSelectionError(problem);
      return;
    }
    resetResults();
    setSelectionError(null);
    setBusy("encrypting");
    try {
      const result = await encryptFile(file);
      const packed = packEncryptedFile(result.encryptedData, result.metadata);
      setKey(result.key);
      setEncrypted({ packed, metadata: result.metadata });
      replaceUrl(setEncryptedUrl, new Blob([packed], { type: "application/octet-stream" }));
    } catch (err) {
      setError(err.message || "Encryption failed.");
    } finally {
      setBusy(null);
    }
  }

  async function handleDecrypt() {
    if (!encrypted || !key) return;
    setBusy("decrypting");
    setError(null);
    replaceUrl(setDecryptedUrl, null);
    setDecrypted(null);
    try {
      // Re-parse the packed file so the container format is exercised too.
      const parsed = unpackEncryptedFile(encrypted.packed);
      const plaintext = await decryptFile(parsed.encryptedData, key, parsed.iv);
      const [originalHash, decryptedHash] = await Promise.all([
        file.arrayBuffer().then(sha256Hex),
        sha256Hex(plaintext),
      ]);
      setDecrypted({ verified: originalHash === decryptedHash });
      replaceUrl(
        setDecryptedUrl,
        new Blob([plaintext], { type: parsed.metadata.mimeType || "application/octet-stream" })
      );
    } catch (err) {
      setError(err.message || "Decryption failed.");
    } finally {
      setBusy(null);
    }
  }

  const working = busy !== null || panelBusy;
  const canEncrypt = Boolean(file) && !selectionError && !working;
  const canDecrypt = Boolean(encrypted && key) && !working;

  return (
    <section className="status-panel enc-section">
      <h2 className="enc-title">Secure File Encryption</h2>
      <p className="enc-help">
        Files are encrypted in your browser with AES-256-GCM before anything leaves
        your device. Only the encrypted file is ever uploaded.
      </p>

      <input
        type="file"
        onChange={handleFileChange}
        disabled={working}
        aria-label="Select a file to encrypt"
      />

      {file && (
        <div className="status-row">
          <strong>Selected:</strong>
          <span>
            {file.name} ({formatBytes(file.size)})
          </span>
        </div>
      )}

      {selectionError && <div className="banner banner-error">{selectionError}</div>}
      {error && <div className="banner banner-error">{error}</div>}

      <div className="enc-actions">
        <button className="connect-btn" onClick={handleEncrypt} disabled={!canEncrypt}>
          {busy === "encrypting" ? "Encrypting..." : "Encrypt File"}
        </button>
        {encryptedUrl && encrypted && (
          <a
            className="download-link"
            href={encryptedUrl}
            download={`${encrypted.metadata.fileName}.enc`}
            aria-disabled={working}
          >
            Download Encrypted File
          </a>
        )}
      </div>

      <div className="status-row">
        <strong>Encryption:</strong>
        {encrypted ? (
          <span className="pill pill-success">succeeded</span>
        ) : (
          <span className="pill pill-warning">not encrypted yet</span>
        )}
      </div>

      {encrypted && (
        <>
          <div className="enc-meta">
            <div>Algorithm: {encrypted.metadata.algorithm}</div>
            <div>MIME type: {encrypted.metadata.mimeType}</div>
            <div>Original size: {formatBytes(encrypted.metadata.originalSize)}</div>
            <div>Encrypted size: {formatBytes(encrypted.metadata.encryptedSize)}</div>
            <div className="enc-iv">IV: {encrypted.metadata.iv}</div>
          </div>

          <div className="banner banner-warning">
            The encryption key exists only in this page's memory. Refreshing or closing
            the tab loses it, and this file could then never be decrypted. There is no
            key backup in this phase. Test decryption now, before leaving the page.
          </div>

          <div className="enc-actions">
            <button className="connect-btn" onClick={handleDecrypt} disabled={!canDecrypt}>
              {busy === "decrypting" ? "Decrypting..." : "Decrypt File"}
            </button>
            {decryptedUrl && (
              <a
                className="download-link"
                href={decryptedUrl}
                download={encrypted.metadata.fileName}
                aria-disabled={working}
              >
                Download Decrypted File
              </a>
            )}
          </div>
        </>
      )}

      {decrypted && decrypted.verified && (
        <div className="banner banner-success">
          Decryption succeeded. The decrypted contents match the original file (SHA-256 verified).
        </div>
      )}
      {decrypted && !decrypted.verified && (
        <div className="banner banner-error">
          Decryption completed but the contents do NOT match the original file.
        </div>
      )}

      <hr className="enc-divider" />

      <IpfsStoragePanel
        storage={storage}
        file={file}
        encrypted={encrypted}
        encryptionKey={key}
        onBusyChange={setPanelBusy}
        contract={contract}
        account={account}
        isWrongNetwork={isWrongNetwork}
        contractError={contractError}
      />
    </section>
  );
}

export default FileEncryption;
