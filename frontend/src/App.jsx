import "./App.css";
import { useWallet } from "./context/WalletContext";
import FileEncryption from "./components/FileEncryption";
import MyFilesDashboard from "./components/MyFilesDashboard";

function shortenAddress(address) {
  if (!address) return "";
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

// Phase 2: wallet connection, network detection, contract wiring.
// Phase 3: local client-side encryption test (no upload yet).
// - Upload/download/share/revoke wiring arrives in Phases 4-7.
// - The full dashboard arrives in Phase 8.
function App() {
  const {
    account,
    networkName,
    isWrongNetwork,
    contract,
    contractError,
    status,
    error,
    connect,
    disconnect,
  } = useWallet();

  return (
    <div className="app-shell">
      <header className="app-header">
        <h1>Decentralized Cloud Storage</h1>

        {!account ? (
          <button
            className="connect-btn"
            onClick={connect}
            disabled={status === "connecting"}
          >
            {status === "connecting" ? "Connecting..." : "Connect Wallet"}
          </button>
        ) : (
          <div className="wallet-info">
            <span className="account-badge" title={account}>
              {shortenAddress(account)}
            </span>
            <button className="disconnect-btn" onClick={disconnect}>
              Disconnect
            </button>
          </div>
        )}
      </header>

      <main className="app-main">
        {status === "error" && error && (
          <div className="banner banner-error">{error}</div>
        )}

        {account && (
          <div className="status-panel">
            <div className="status-row">
              <strong>Account:</strong> <span>{account}</span>
            </div>
            <div className="status-row">
              <strong>Network:</strong>{" "}
              <span>{networkName || "Detecting..."}</span>
            </div>
            <div className="status-row">
              <strong>Contract:</strong>{" "}
              {contract ? (
                <span className="pill pill-success">connected</span>
              ) : (
                <span className="pill pill-warning">not connected</span>
              )}
            </div>

            {isWrongNetwork && (
              <div className="banner banner-warning">
                Wrong network — switch MetaMask to {" "}
                <strong>Hardhat Local (chain ID 31337)</strong> for local dev.
              </div>
            )}

            {contractError && (
              <div className="banner banner-warning">{contractError}</div>
            )}

            {contract && !isWrongNetwork && (
              <div className="banner banner-success">
                Wallet and contract are ready. Upload/download features are
                built out in later phases.
              </div>
            )}
          </div>
        )}

        <FileEncryption
          contract={contract}
          account={account}
          isWrongNetwork={isWrongNetwork}
          contractError={contractError}
        />

        {!account && status !== "connecting" && status !== "error" && (
          <p className="placeholder-note">
            Connect your wallet to continue. File upload, encryption, and
            sharing are built out in later phases.
          </p>
        )}
      </main>
    </div>
  );
}

export default App;
