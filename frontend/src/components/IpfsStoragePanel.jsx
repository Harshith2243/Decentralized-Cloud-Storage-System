import { useEffect, useRef, useState } from "react";
import { storage as defaultStorage } from "../services/storageService";
import { decryptFile, unpackEncryptedFile, formatBytes } from "../utils/crypto";

// Phase 4: upload the ENCRYPTED container to IPFS (via the backend), show the CID,
// retrieve by CID, and decrypt with the key that is still held in memory.
// Only encrypted bytes ever leave the browser. The key never leaves this page.

async function sha256Hex(buffer) {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

// File names inside a retrieved container are untrusted input.
function safeFileName(name) {
  const cleaned = String(name || "").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").slice(0, 200);
  return cleaned || "decrypted-file";
}

const IDLE_UPLOAD = { status: "idle", progress: null, cid: null, error: null };

function Chip({ tone, children }) {
  return <span className={`pill pill-${tone}`}>{children}</span>;
}

function IpfsStoragePanel({
  storage = defaultStorage,
  file,
  encrypted,
  encryptionKey,
  onBusyChange,
  contract = null,
  account = null,
  isWrongNetwork = false,
  contractError = null,
}) {
  const [upload, setUpload] = useState(IDLE_UPLOAD);
  const [copied, setCopied] = useState(null); // null | "copied" | "failed"

  const [blockchainTx, setBlockchainTx] = useState({
    status: "idle", // idle | recording | success | error
    hash: null,
    fileId: null,
    error: null,
  });

  const [cidInput, setCidInput] = useState("");
  const [rvStatus, setRvStatus] = useState("idle"); // idle | retrieving | retrieved | decrypting | decrypted
  const [rvError, setRvError] = useState(null);
  const [rvProgress, setRvProgress] = useState(null);
  const [retrieved, setRetrieved] = useState(null); // { cid, bytes, parsed }
  const [verification, setVerification] = useState(null); // "verified" | "mismatch" | "unverified"
  const [retrievedUrl, setRetrievedUrl] = useState(null);
  const [decryptedUrl, setDecryptedUrl] = useState(null);
  const [decryptedName, setDecryptedName] = useState("");

  const uploadedCidRef = useRef(null); // CID of the file encrypted in THIS session (reference for hash checks)
  const urlsRef = useRef({});
  urlsRef.current = { retrievedUrl, decryptedUrl };

  const busy =
    upload.status === "uploading" ||
    rvStatus === "retrieving" ||
    rvStatus === "decrypting" ||
    blockchainTx.status === "recording";

  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);

  useEffect(
    () => () => {
      const { retrievedUrl: r, decryptedUrl: d } = urlsRef.current;
      if (r) URL.revokeObjectURL(r);
      if (d) URL.revokeObjectURL(d);
    },
    []
  );

  useEffect(() => {
    if (!copied) return undefined;
    const t = setTimeout(() => setCopied(null), 2500);
    return () => clearTimeout(t);
  }, [copied]);

  // A new/cleared encryption invalidates the previous upload result and session key.
  useEffect(() => {
    setUpload(IDLE_UPLOAD);
    uploadedCidRef.current = null;
    resetRetrieval();
    setBlockchainTx({ status: "idle", hash: null, fileId: null, error: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [encrypted]);

  function swapUrl(setter, blob) {
    setter((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return blob ? URL.createObjectURL(blob) : null;
    });
  }

  function resetRetrieval() {
    setRvStatus("idle");
    setRvError(null);
    setRvProgress(null);
    setRetrieved(null);
    setVerification(null);
    swapUrl(setRetrievedUrl, null);
    swapUrl(setDecryptedUrl, null);
  }

  async function handleUpload() {
    if (!encrypted) return;
    setCopied(null);
    setUpload({ status: "uploading", progress: null, cid: null, error: null });
    try {
      // Only the encrypted container bytes are sent. No key, no plaintext.
      const { cid } = await storage.uploadEncryptedFile(encrypted.packed, {
        onProgress: (progress) => setUpload((u) => (u.status === "uploading" ? { ...u, progress } : u)),
      });
      uploadedCidRef.current = cid; // set only after the provider confirmed
      setUpload({ status: "success", progress: null, cid, error: null });
      setCidInput(cid);
    } catch (err) {
      setUpload({ status: "error", progress: null, cid: null, error: err.message || "Upload failed." });
    }
  }

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(upload.cid);
      setCopied("copied");
    } catch {
      setCopied("failed");
    }
  }

  async function handleSaveToBlockchain() {
    if (!upload.cid) return;

    if (!account) {
      setBlockchainTx({
        status: "error",
        hash: null,
        fileId: null,
        error: "Wallet not connected. Connect your MetaMask wallet first.",
      });
      return;
    }

    if (isWrongNetwork) {
      setBlockchainTx({
        status: "error",
        hash: null,
        fileId: null,
        error: "Wrong network. Please switch MetaMask to Hardhat Local (chain ID 31337).",
      });
      return;
    }

    if (!contract) {
      setBlockchainTx({
        status: "error",
        hash: null,
        fileId: null,
        error: contractError || "Smart contract is not available.",
      });
      return;
    }

    try {
      if (typeof contract.getDeployedCode === "function") {
        const code = await contract.getDeployedCode();
        if (!code || code === "0x") {
          setBlockchainTx({
            status: "error",
            hash: null,
            fileId: null,
            error: "Contract is not deployed at the configured address on the local network.",
          });
          return;
        }
      }
    } catch (verifyErr) {
      setBlockchainTx({
        status: "error",
        hash: null,
        fileId: null,
        error: verifyErr?.message || "Failed to verify contract deployment.",
      });
      return;
    }

    setBlockchainTx({ status: "recording", hash: null, fileId: null, error: null });

    try {
      const fileName = file?.name || encrypted?.metadata?.fileName || "unnamed";
      const fileSize = file?.size ?? encrypted?.metadata?.originalSize ?? 0;

      const tx = await contract.uploadFile(upload.cid, fileName, fileSize);
      setBlockchainTx({ status: "recording", hash: tx.hash, fileId: null, error: null });

      const receipt = await tx.wait();
      let fileId = null;
      if (receipt && receipt.logs && contract.interface) {
        for (const log of receipt.logs) {
          try {
            const parsed = contract.interface.parseLog(log);
            if (parsed && parsed.name === "FileUploaded") {
              fileId = parsed.args[0]?.toString() || parsed.args.fileId?.toString();
              break;
            }
          } catch {
            /* ignore non-matching logs */
          }
        }
      }

      setBlockchainTx({
        status: "success",
        hash: receipt?.hash || tx.hash,
        fileId,
        error: null,
      });
    } catch (err) {
      const isUserRejected =
        err?.code === 4001 ||
        err?.info?.error?.code === 4001 ||
        (err?.code === "ACTION_REJECTED" && (
          err?.info?.error?.code === 4001 ||
          /user rejected/i.test(err?.message || "") ||
          /user denied/i.test(err?.message || "")
        )) ||
        /user rejected/i.test(err?.message || "") ||
        /user denied/i.test(err?.message || "");

      const errorMsg = isUserRejected
        ? "Transaction was rejected in MetaMask."
        : (err?.reason || err?.shortMessage || err?.info?.error?.message || err?.message || "Transaction failed.");

      setBlockchainTx({
        status: "error",
        hash: null,
        fileId: null,
        error: errorMsg,
      });
    }
  }

  async function handleRetrieve() {
    const cid = cidInput.trim();
    resetRetrieval();
    if (!storage.validateCID(cid)) {
      setRvStatus("idle");
      setRvError("Invalid CID. Paste a CID that starts with Qm… or bafy….");
      return;
    }
    setRvStatus("retrieving");
    try {
      const bytes = await storage.retrieveEncryptedFile(cid, { onProgress: setRvProgress });
      let parsed;
      try {
        parsed = unpackEncryptedFile(bytes); // validates signature, header and lengths
      } catch (err) {
        throw new Error(`Retrieved data is not a valid encrypted file: ${err.message}`);
      }
      setRetrieved({ cid, bytes, parsed });
      swapUrl(setRetrievedUrl, new Blob([bytes], { type: "application/octet-stream" }));
      setRvStatus("retrieved");
    } catch (err) {
      setRvStatus("idle");
      setRvError(err.message || "Retrieval failed.");
    } finally {
      setRvProgress(null);
    }
  }

  async function handleDecrypt() {
    if (!retrieved || !encryptionKey) return;
    setRvStatus("decrypting");
    setRvError(null);
    setVerification(null);
    swapUrl(setDecryptedUrl, null);
    try {
      const { parsed, cid } = retrieved;
      const plaintext = await decryptFile(parsed.encryptedData, encryptionKey, parsed.iv); // throws unless AES-GCM auth passes
      let result = "unverified";
      if (file && uploadedCidRef.current === cid) {
        const [a, b] = await Promise.all([file.arrayBuffer().then(sha256Hex), sha256Hex(plaintext)]);
        result = a === b ? "verified" : "mismatch";
      }
      setVerification(result);
      setDecryptedName(safeFileName(parsed.metadata.fileName));
      swapUrl(setDecryptedUrl, new Blob([plaintext], { type: parsed.metadata.mimeType || "application/octet-stream" }));
      setRvStatus("decrypted");
    } catch (err) {
      setRvStatus("retrieved");
      setRvError(err.message || "Decryption failed.");
    }
  }

  const failed = upload.status === "error" || Boolean(rvError) || blockchainTx.status === "error";
  const canUpload = Boolean(encrypted) && !busy && upload.status !== "success";
  const canRetrieve = cidInput.trim().length > 0 && !busy;
  const canDecrypt = Boolean(retrieved && encryptionKey) && !busy;

  const pct = (p) => (p && p.total ? Math.round((p.loaded / p.total) * 100) : null);

  return (
    <div className="ipfs-panel">
      <h3 className="enc-title">IPFS Storage</h3>

      <div className="chip-row" aria-label="Progress">
        <Chip tone={file ? "success" : "neutral"}>{file ? "File selected" : "No file selected"}</Chip>
        <Chip tone={encrypted ? "success" : "neutral"}>{encrypted ? "Encryption completed" : "Not encrypted"}</Chip>
        <Chip tone={upload.status === "success" ? "success" : upload.status === "uploading" ? "warning" : "neutral"}>
          {upload.status === "uploading" ? "Upload in progress" : upload.status === "success" ? "Upload successful" : "Not uploaded"}
        </Chip>
        <Chip tone={blockchainTx.status === "success" ? "success" : blockchainTx.status === "recording" ? "warning" : "neutral"}>
          {blockchainTx.status === "recording" ? "Recording on-chain" : blockchainTx.status === "success" ? "Recorded on blockchain" : "Not on blockchain"}
        </Chip>
        <Chip tone={rvStatus === "retrieving" ? "warning" : retrieved ? "success" : "neutral"}>
          {rvStatus === "retrieving" ? "Retrieval in progress" : retrieved ? "Retrieval successful" : "Not retrieved"}
        </Chip>
        <Chip tone={rvStatus === "decrypted" ? "success" : "neutral"}>
          {rvStatus === "decrypted" ? "Decryption successful" : "Not decrypted"}
        </Chip>
        {failed && <Chip tone="error">Operation failed</Chip>}
      </div>

      <div className="banner banner-warning">
        <strong>Before you upload:</strong> IPFS is public. Anyone who has the CID can download the encrypted file,
        and the file name, type and size are visible in its header. The file contents stay unreadable without the key.
        The key is held only in this page's memory and is never uploaded, so the CID alone cannot decrypt anything.
        If you refresh the page the key is lost and the file becomes unrecoverable. Storage is on the configured IPFS
        node only and is not guaranteed to be permanent.
      </div>

      <div className="enc-actions">
        <button className="connect-btn" onClick={handleUpload} disabled={!canUpload}>
          {upload.status === "uploading" ? "Uploading..." : "Upload Encrypted File to IPFS"}
        </button>
      </div>

      {upload.status === "uploading" && (
        <div className="progress-wrap" role="status">
          {pct(upload.progress) !== null ? (
            <>
              <progress value={upload.progress.loaded} max={upload.progress.total} />
              <span>{pct(upload.progress)}%</span>
            </>
          ) : (
            <span>Uploading to IPFS...</span>
          )}
        </div>
      )}

      {upload.status === "error" && <div className="banner banner-error">{upload.error}</div>}

      {upload.status === "success" && (
        <div className="banner banner-success">
          <div>Upload successful. IPFS confirmed the content and returned this CID:</div>
          <div className="cid-box" data-testid="uploaded-cid">{upload.cid}</div>
          <div className="enc-actions">
            <button className="download-link" onClick={handleCopy}>Copy CID</button>
            {copied === "copied" && <span className="copy-note"> Copied.</span>}
            {copied === "failed" && <span className="copy-note"> Copy failed. Select the CID above manually.</span>}
          </div>

          <div style={{ marginTop: "1rem" }}>
            <button
              className="connect-btn"
              onClick={handleSaveToBlockchain}
              disabled={busy || blockchainTx.status === "recording" || blockchainTx.status === "success"}
            >
              {blockchainTx.status === "recording" ? "Saving to Blockchain..." : "Save CID to Blockchain"}
            </button>
          </div>

          {!account && (
            <div className="banner banner-warning" style={{ marginTop: "0.5rem" }}>
              Wallet not connected. Connect your wallet above to record this file on the blockchain.
            </div>
          )}

          {account && isWrongNetwork && (
            <div className="banner banner-warning" style={{ marginTop: "0.5rem" }}>
              Wrong network. Switch MetaMask to Hardhat Local (chain ID 31337) to record on the blockchain.
            </div>
          )}

          {blockchainTx.status === "recording" && (
            <div className="progress-wrap" role="status" style={{ marginTop: "0.5rem" }}>
              <span>Transaction submitted{blockchainTx.hash ? ` (${blockchainTx.hash.slice(0, 10)}...)` : ""}. Waiting for confirmation...</span>
            </div>
          )}

          {blockchainTx.status === "error" && (
            <div className="banner banner-error" style={{ marginTop: "0.5rem" }}>
              {blockchainTx.error}
            </div>
          )}

          {blockchainTx.status === "success" && (
            <div className="banner banner-success" style={{ marginTop: "0.5rem" }} data-testid="blockchain-success">
              <div><strong>Recorded on Blockchain!</strong></div>
              {blockchainTx.fileId && <div>File ID: #{blockchainTx.fileId}</div>}
              <div>Transaction Hash: <span className="cid-box" style={{ fontSize: "0.85em" }}>{blockchainTx.hash}</span></div>
            </div>
          )}
        </div>
      )}

      <hr className="enc-divider" />

      <label className="field-label" htmlFor="cid-input">Retrieve by CID</label>
      <input
        id="cid-input"
        className="text-input"
        type="text"
        value={cidInput}
        onChange={(e) => setCidInput(e.target.value)}
        placeholder="Qm… or bafy…"
        spellCheck={false}
        autoComplete="off"
        disabled={busy}
        aria-label="CID to retrieve"
      />

      <div className="enc-actions">
        <button className="connect-btn" onClick={handleRetrieve} disabled={!canRetrieve}>
          {rvStatus === "retrieving" ? "Retrieving..." : "Retrieve from IPFS"}
        </button>
        {retrievedUrl && (
          <a className="download-link" href={retrievedUrl} download="retrieved.enc">
            Download Retrieved Encrypted File
          </a>
        )}
      </div>

      {rvStatus === "retrieving" && (
        <div className="progress-wrap" role="status">
          {pct(rvProgress) !== null ? <progress value={rvProgress.loaded} max={rvProgress.total} /> : null}
          <span>Retrieving from IPFS{rvProgress ? ` (${formatBytes(rvProgress.loaded)})` : "..."}</span>
        </div>
      )}

      {rvError && <div className="banner banner-error">{rvError}</div>}

      {retrieved && (
        <>
          <div className="banner banner-success">
            Retrieval successful. The data is a valid encrypted container ({formatBytes(retrieved.bytes.length)}, {retrieved.parsed.metadata.algorithm}).
          </div>
          {!encryptionKey && (
            <div className="banner banner-warning">
              No encryption key is in memory, so this file cannot be decrypted. Keys are not stored or backed up in this phase.
            </div>
          )}
          <div className="enc-actions">
            <button className="connect-btn" onClick={handleDecrypt} disabled={!canDecrypt}>
              {rvStatus === "decrypting" ? "Decrypting..." : "Decrypt Retrieved File"}
            </button>
            {decryptedUrl && (
              <a className="download-link" href={decryptedUrl} download={decryptedName}>
                Download Retrieved Decrypted File
              </a>
            )}
          </div>
        </>
      )}

      {rvStatus === "decrypted" && verification === "verified" && (
        <div className="banner banner-success">
          Decryption successful. The decrypted contents match the original file (SHA-256 verified).
        </div>
      )}
      {rvStatus === "decrypted" && verification === "unverified" && (
        <div className="banner banner-warning">
          Decryption successful (AES-GCM authentication passed). No original reference hash is available for this CID
          in this session, so the contents were not compared with an original file.
        </div>
      )}
      {rvStatus === "decrypted" && verification === "mismatch" && (
        <div className="banner banner-error">
          Decryption completed but the contents do NOT match the original file.
        </div>
      )}
    </div>
  );
}

export default IpfsStoragePanel;
