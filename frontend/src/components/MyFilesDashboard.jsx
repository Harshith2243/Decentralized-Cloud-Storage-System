import { useCallback, useEffect, useState } from "react";
import { ethers } from "ethers";

function explain(error) {
  return error?.shortMessage || error?.reason || error?.message || "The blockchain request failed.";
}

export default function MyFilesDashboard({ contract, account, isWrongNetwork }) {
  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [addresses, setAddresses] = useState({});
  const [busyFile, setBusyFile] = useState(null);

  const refresh = useCallback(async () => {
    if (!contract || !account || isWrongNetwork) {
      setFiles([]);
      return;
    }
    setLoading(true);
    setError("");
    try {
      const ids = await contract.getFilesByOwner(account);
      const rows = await Promise.all(ids.map(async (id) => {
        const f = await contract.getFile(id);
        return {
          id: id.toString(),
          owner: f.owner ?? f[1],
          cid: f.cid ?? f[2],
          fileName: f.fileName ?? f[3],
          fileSize: (f.fileSize ?? f[4]).toString(),
          uploadedAt: (f.uploadedAt ?? f[5]).toString(),
        };
      }));
      setFiles(rows.reverse());
    } catch (err) {
      setError(explain(err));
    } finally {
      setLoading(false);
    }
  }, [contract, account, isWrongNetwork]);

  useEffect(() => { refresh(); }, [refresh]);

  async function changeAccess(file, action) {
    const address = (addresses[file.id] || "").trim();
    if (!ethers.isAddress(address)) {
      setError("Enter a valid Ethereum wallet address.");
      return;
    }
    setBusyFile(file.id);
    setError("");
    setNotice("");
    try {
      const tx = action === "share"
        ? await contract.shareFile(file.id, address)
        : await contract.revokeAccess(file.id, address);
      await tx.wait();
      setNotice(`Access ${action === "share" ? "granted to" : "revoked from"} ${address} for file #${file.id}.`);
      await refresh();
    } catch (err) {
      setError(explain(err));
    } finally {
      setBusyFile(null);
    }
  }

  if (!account) return null;

  return (
    <section className="status-panel" aria-labelledby="my-files-heading">
      <div className="status-row" style={{ justifyContent: "space-between" }}>
        <h2 id="my-files-heading">My Files</h2>
        <button type="button" className="download-link" onClick={refresh} disabled={loading || isWrongNetwork}>
          {loading ? "Refreshing..." : "Refresh"}
        </button>
      </div>
      {isWrongNetwork && <div className="banner banner-warning">Switch MetaMask to Hardhat Local (chain ID 31337) to view files.</div>}
      {error && <div className="banner banner-error" role="alert">{error}</div>}
      {notice && <div className="banner banner-success" role="status">{notice}</div>}
      {!loading && !error && files.length === 0 && <p>No files registered by this wallet yet.</p>}
      {files.map((file) => (
        <article key={file.id} className="status-panel" style={{ marginTop: "0.75rem" }}>
          <h3>{file.fileName || "Unnamed file"} <small>(#{file.id})</small></h3>
          <div className="status-row"><strong>Size:</strong><span>{file.fileSize} bytes</span></div>
          <div className="status-row"><strong>CID:</strong><code style={{ overflowWrap: "anywhere" }}>{file.cid}</code></div>
          <label className="field-label" htmlFor={`share-${file.id}`}>Wallet address</label>
          <input
            id={`share-${file.id}`}
            className="text-input"
            value={addresses[file.id] || ""}
            onChange={(event) => setAddresses((prev) => ({ ...prev, [file.id]: event.target.value }))}
            placeholder="0x..."
            spellCheck={false}
            autoComplete="off"
            disabled={busyFile === file.id || isWrongNetwork}
          />
          <div className="enc-actions">
            <button type="button" className="connect-btn" onClick={() => changeAccess(file, "share")} disabled={busyFile === file.id || isWrongNetwork}>
              {busyFile === file.id ? "Processing..." : "Share Access"}
            </button>
            <button type="button" className="download-link" onClick={() => changeAccess(file, "revoke")} disabled={busyFile === file.id || isWrongNetwork}>
              Revoke Access
            </button>
          </div>
          <p className="placeholder-note">Sharing blockchain permission does not deliver the encryption key to the recipient. Revocation cannot erase copies or keys already obtained.</p>
        </article>
      ))}
    </section>
  );
}
