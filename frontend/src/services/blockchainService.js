import { ethers } from "ethers";
import FileStorageABI from "../utils/FileStorageABI.json";
import { CONTRACT_ADDRESS } from "../utils/constants";

// Module-level cache so we don't create a new BrowserProvider/signer on every
// call. Cleared by resetConnection() on disconnect.
let cachedProvider = null;
let cachedSigner = null;

export function isMetaMaskInstalled() {
  return typeof window !== "undefined" && Boolean(window.ethereum);
}

/**
 * Returns a cached ethers BrowserProvider wrapping window.ethereum.
 * Throws a clear error if MetaMask (or any EIP-1193 wallet) isn't present.
 */
export function getProvider() {
  if (!isMetaMaskInstalled()) {
    throw new Error(
      "MetaMask is not installed. Install it from https://metamask.io and reload the page."
    );
  }
  if (!cachedProvider) {
    cachedProvider = new ethers.BrowserProvider(window.ethereum);
  }
  return cachedProvider;
}

/**
 * Prompts the MetaMask connect popup (if not already authorized) and
 * returns the selected account address.
 */
export async function connectWallet() {
  const provider = getProvider();
  const accounts = await provider.send("eth_requestAccounts", []);
  if (!accounts || accounts.length === 0) {
    throw new Error("MetaMask returned no accounts. Unlock MetaMask and try again.");
  }
  cachedSigner = await provider.getSigner();
  return accounts[0];
}

/**
 * Silently checks for an already-authorized account (no popup). Used on
 * page load to restore a previous session. Returns null if none.
 */
export async function getCurrentAccount() {
  if (!isMetaMaskInstalled()) return null;
  const provider = getProvider();
  const accounts = await provider.send("eth_accounts", []);
  if (!accounts || accounts.length === 0) return null;
  cachedSigner = await provider.getSigner();
  return accounts[0];
}

/**
 * Returns { chainId, name } for the currently connected network.
 */
export async function getNetwork() {
  const provider = getProvider();
  const network = await provider.getNetwork();
  return {
    chainId: Number(network.chainId),
    name: network.name,
  };
}

/**
/**
 * Clears the cached signer so subsequent contract instances bind to the
 * currently active MetaMask account.
 */
export function clearCachedSigner() {
  cachedSigner = null;
}

/**
 * Returns an ethers Contract instance for FileStorage, connected with the
 * current signer so it can send transactions as well as read state.
 * Throws if the contract address isn't configured, undeployed, or no wallet is connected.
 */
export async function getContract() {
  if (!CONTRACT_ADDRESS) {
    throw new Error(
      "Contract address is not configured. Set VITE_CONTRACT_ADDRESS in frontend/.env"
    );
  }
  if (!ethers.isAddress(CONTRACT_ADDRESS)) {
    throw new Error(`VITE_CONTRACT_ADDRESS is not a valid address: "${CONTRACT_ADDRESS}"`);
  }
  const provider = getProvider();
  const code = await provider.getCode(CONTRACT_ADDRESS);
  if (!code || code === "0x") {
    throw new Error(
      `FileStorage contract is not deployed at ${CONTRACT_ADDRESS} on the connected network. Deploy the contract using 'npx hardhat run scripts/deploy.js --network localhost' and update VITE_CONTRACT_ADDRESS.`
    );
  }
  cachedSigner = await provider.getSigner();
  return new ethers.Contract(CONTRACT_ADDRESS, FileStorageABI, cachedSigner);
}

/**
 * Subscribes to MetaMask's accountsChanged event. Returns an unsubscribe fn.
 */
export function onAccountsChanged(callback) {
  if (!isMetaMaskInstalled()) return () => {};
  window.ethereum.on("accountsChanged", callback);
  return () => window.ethereum.removeListener("accountsChanged", callback);
}

/**
 * Subscribes to MetaMask's chainChanged event. Returns an unsubscribe fn.
 */
export function onChainChanged(callback) {
  if (!isMetaMaskInstalled()) return () => {};
  window.ethereum.on("chainChanged", callback);
  return () => window.ethereum.removeListener("chainChanged", callback);
}

/**
 * Clears cached provider/signer. MetaMask has no programmatic "disconnect"
 * API for the injected provider — this only resets THIS app's in-memory
 * state, so the UI returns to a logged-out view. The site remains
 * authorized in MetaMask itself until the user revokes it there.
 */
export function resetConnection() {
  cachedProvider = null;
  cachedSigner = null;
}
