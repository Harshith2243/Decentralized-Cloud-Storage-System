import { useRef, useState } from "react";
import { exportEncryptionKey, importEncryptionKey } from "../utils/crypto";

// A backup contains a raw encryption key. Anyone holding it can decrypt the
// associated ciphertext, so the user must keep this file private.
export default function KeyBackupControls({ encryptionKey, setEncryptionKey, fileName, disabled = false }) {
  const inputRef = useRef(null);
  const [message, setMessage] = useState(null);

  async function exportBackup() {
    if (!encryptionKey) return;
    try {
      const backup = {
        format: "DCS-KEY-BACKUP",
        version: 1,
        algorithm: "AES-256-GCM",
        fileName: fileName || "unknown",
        exportedAt: new Date().toISOString(),
        key: await exportEncryptionKey(encryptionKey),
      };
      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${(fileName || "file").replace(/[\\/:*?"<>|]/g, "_")}.key-backup.json`;
      anchor.click();
      URL.revokeObjectURL(url);
      setMessage({ type: "success", text: "Key backup downloaded. Keep it private and separate from the encrypted file." });
    } catch (error) {
      setMessage({ type: "error", text: error.message || "Could not export the key backup." });
    }
  }

  async function importBackup(event) {
    const backupFile = event.target.files?.[0];
    event.target.value = "";
    if (!backupFile) return;
    try {
      const text = await backupFile.text();
      const backup = JSON.parse(text);
      if (backup?.format !== "DCS-KEY-BACKUP" || backup?.version !== 1 ||
          backup?.algorithm !== "AES-256-GCM" || typeof backup?.key !== "string") {
        throw new Error("This is not a supported DCS key backup file.");
      }
      const restoredKey = await importEncryptionKey(backup.key);
      setEncryptionKey(restoredKey);
      setMessage({ type: "success", text: `Key imported for "${String(backup.fileName || "unknown file").slice(0, 100)}". Retrieve that file's encrypted CID, then decrypt it.` });
    } catch (error) {
      setMessage({ type: "error", text: error.message || "Could not import the key backup." });
    }
  }

  return (
    <div className="status-panel" style={{ marginTop: "1rem" }}>
      <h3>Encryption Key Backup</h3>
      <p>
        Back up the key before refreshing or closing this page. The backup contains a secret key
        and is not password-protected. Anyone who obtains it may decrypt the associated file.
        Never upload this backup to IPFS or commit it to GitHub.
      </p>
      <div className="enc-actions">
        <button type="button" className="connect-btn" onClick={exportBackup} disabled={!encryptionKey || disabled}>
          Export Key Backup
        </button>
        <button type="button" className="download-link" onClick={() => inputRef.current?.click()} disabled={disabled}>
          Import Key Backup
        </button>
        <input ref={inputRef} type="file" accept=".json,application/json" onChange={importBackup} hidden disabled={disabled} />
      </div>
      {message && <div role="status" className={`banner banner-${message.type === "error" ? "error" : "success"}`}>{message.text}</div>}
    </div>
  );
}
