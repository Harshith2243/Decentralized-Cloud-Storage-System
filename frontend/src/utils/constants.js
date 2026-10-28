// Loaded from frontend/.env (Vite requires the VITE_ prefix to expose a var
// to client code). Never hardcode the contract address in components —
// everything reads it from here.
export const CONTRACT_ADDRESS = import.meta.env.VITE_CONTRACT_ADDRESS || "";

// Network the app expects to be connected to for local development.
// Hardhat's default local chain ID is 31337.
export const EXPECTED_CHAIN_ID = Number(import.meta.env.VITE_CHAIN_ID || 31337);
export const EXPECTED_NETWORK_NAME = import.meta.env.VITE_NETWORK_NAME || "Hardhat Local";
export const RPC_URL = import.meta.env.VITE_RPC_URL || "http://127.0.0.1:8545";

// Friendly labels for chain IDs we're likely to see during dev/demo.
export const NETWORK_NAMES = {
  1: "Ethereum Mainnet",
  11155111: "Sepolia Testnet",
  31337: "Hardhat Local",
  1337: "Localhost",
};

// Public URL of this project's backend (NOT a secret). IPFS credentials live
// only in backend/.env and are never exposed to the browser.
export const BACKEND_URL = (import.meta.env.VITE_BACKEND_URL || "http://localhost:5000").replace(/\/+$/, "");
