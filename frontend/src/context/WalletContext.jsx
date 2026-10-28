import { createContext, useContext, useCallback, useEffect, useState } from "react";
import {
  isMetaMaskInstalled,
  connectWallet as connectWalletService,
  getCurrentAccount,
  getContract as getContractService,
  getNetwork,
  onAccountsChanged,
  onChainChanged,
  resetConnection,
  clearCachedSigner,
} from "../services/blockchainService";
import { EXPECTED_CHAIN_ID, NETWORK_NAMES } from "../utils/constants";

const WalletContext = createContext(undefined);

// status: "idle" | "connecting" | "connected" | "error"
export function WalletProvider({ children }) {
  const [account, setAccount] = useState(null);
  const [chainId, setChainId] = useState(null);
  const [contract, setContract] = useState(null);
  const [contractError, setContractError] = useState(null);
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState(null);

  const refreshNetwork = useCallback(async () => {
    try {
      const network = await getNetwork();
      setChainId(network.chainId);
    } catch {
      setChainId(null);
    }
  }, []);

  const loadContract = useCallback(async () => {
    try {
      const c = await getContractService();
      setContract(c);
      setContractError(null);
    } catch (err) {
      // A missing/misconfigured contract address shouldn't block wallet
      // connection — surface it as its own, separate error state.
      setContract(null);
      setContractError(err.message || "Failed to load contract.");
    }
  }, []);

  const connect = useCallback(async () => {
    if (!isMetaMaskInstalled()) {
      setError("MetaMask is not installed. Install it from https://metamask.io and reload the page.");
      setStatus("error");
      return;
    }
    setStatus("connecting");
    setError(null);
    try {
      const acc = await connectWalletService();
      setAccount(acc);
      await refreshNetwork();
      await loadContract();
      setStatus("connected");
    } catch (err) {
      // MetaMask throws { code: 4001 } when the user rejects the popup.
      const message =
        err?.code === 4001
          ? "Connection request was rejected."
          : err.message || "Failed to connect wallet.";
      setError(message);
      setStatus("error");
    }
  }, [refreshNetwork, loadContract]);

  const disconnect = useCallback(() => {
    resetConnection();
    setAccount(null);
    setChainId(null);
    setContract(null);
    setContractError(null);
    setStatus("idle");
    setError(null);
  }, []);

  // On mount: silently restore the session if this site is already
  // authorized in MetaMask (no popup shown).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!isMetaMaskInstalled()) return;
      try {
        const acc = await getCurrentAccount();
        if (cancelled || !acc) return;
        setAccount(acc);
        await refreshNetwork();
        await loadContract();
        setStatus("connected");
      } catch (err) {
        if (!cancelled) {
          setError(err.message);
          setStatus("error");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshNetwork, loadContract]);

  // React to account/network changes triggered from inside MetaMask itself.
  useEffect(() => {
    const offAccounts = onAccountsChanged((accounts) => {
      if (!accounts || accounts.length === 0) {
        disconnect();
      } else {
        clearCachedSigner();
        setAccount(accounts[0]);
        loadContract();
      }
    });

    const offChain = onChainChanged(() => {
      // Reloading on chain change is the approach MetaMask's own docs
      // recommend, since providers/signers are bound to a chain.
      window.location.reload();
    });

    return () => {
      offAccounts();
      offChain();
    };
  }, [disconnect, loadContract]);

  const isWrongNetwork = chainId !== null && chainId !== EXPECTED_CHAIN_ID;

  const value = {
    account,
    chainId,
    networkName: chainId ? NETWORK_NAMES[chainId] || `Chain ${chainId}` : null,
    isWrongNetwork,
    contract,
    contractError,
    status,
    error,
    connect,
    disconnect,
  };

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet() {
  const ctx = useContext(WalletContext);
  if (!ctx) {
    throw new Error("useWallet must be used within a WalletProvider");
  }
  return ctx;
}
