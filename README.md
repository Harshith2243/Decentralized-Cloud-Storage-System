# Decentralized Cloud Storage System — Phase 1

Google-Drive-like app, but files are encrypted client-side, stored on
IPFS/Filecoin, and access is controlled by an Ethereum smart contract instead
of a central server.

## Architecture

```
Frontend (React + Vite)
        │  Ethers.js + MetaMask
        ▼
Blockchain (Solidity / Ethereum testnet)   ← stores CID + access control ONLY
        │
        ▼
Decentralized Storage (IPFS/Filecoin)      ← stores the ENCRYPTED file bytes

Backend (Node.js + Express)                ← relays uploads to IPFS, never
                                              sees plaintext or private keys
```

The chain never holds a file, and never holds an encryption key — only a CID
pointer, an owner address, and a permission list.

## Folder structure

```
decentralized-cloud-storage/
├── blockchain/              Solidity contract, Hardhat project
│   ├── contracts/FileStorage.sol
│   ├── scripts/deploy.js
│   ├── test/FileStorage.test.js
│   └── hardhat.config.js
├── backend/                 Express API (encrypted-file relay to IPFS)
│   ├── server.js
│   ├── routes/storageRoutes.js       (/api/storage/*)
│   ├── controllers/storageController.js
│   └── providers/KuboProvider.js     (IPFS provider)
└── frontend/                React + Vite app (wallet UI — stubbed until Phase 2)
    └── src/App.jsx
```

## Smart contract (`FileStorage.sol`)

| Function | Purpose |
|---|---|
| `uploadFile(cid, fileName, fileSize)` | Registers metadata for an already-encrypted, already-pinned file. Owner gets automatic access. |
| `shareFile(fileId, address)` | Owner-only. Grants another wallet access. |
| `revokeAccess(fileId, address)` | Owner-only. Removes a wallet's access. |
| `hasAccess(fileId, address)` | Public view — check permission. |
| `getFile(fileId)` | Returns metadata; **reverts if caller lacks access**, so access control is enforced on-chain, not just hidden in the UI. |
| `getFilesByOwner(address)` | Convenience list for a "My Files" view. |

Events (`FileUploaded`, `AccessShared`, `AccessRevoked`) are emitted for every
state change so the frontend can build a transaction history feed later.

Design choices worth knowing:
- **No encryption keys on-chain, ever.** Key management is deferred to Phase 3
  and will live client-side (with a scheme decided then — e.g. per-file symmetric
  key encrypted for each recipient's public key).
- **`onlyOwner` / `fileExists` modifiers** keep authorization logic out of the
  frontend — a malicious or modified UI still can't bypass access checks.
- **Optimizer enabled, 0.8.20** — recent enough for custom errors etc. if you
  want to optimize gas later, but `require` strings are used for now for
  readability while you're building/debugging.

## Prerequisites

- Node.js 18+
- MetaMask browser extension
- A free Sepolia RPC URL (Alchemy or Infura) — only needed for testnet deploys, not local dev

## Install, compile, test

```bash
# 1. Smart contract
cd blockchain
npm install
npx hardhat compile
npx hardhat test

# 2. Local blockchain (separate terminal, keep running)
npx hardhat node

# 3. Deploy to local chain (separate terminal)
npx hardhat run scripts/deploy.js --network localhost
# copy the printed contract address into frontend/src/utils/constants.js
# and backend/.env (CONTRACT_ADDRESS)

# 4. Backend
cd ../backend
npm install
cp .env.example .env
npm run dev          # http://localhost:5000/health should return {"status":"ok"}

# 5. Frontend
cd ../frontend
npm install
npm run dev           # http://localhost:5173
```

### Deploying to Sepolia testnet (later, once you're ready to demo on a real testnet)

```bash
cd blockchain
cp .env.example .env
# fill in SEPOLIA_RPC_URL and PRIVATE_KEY (a TESTNET-ONLY wallet)
npx hardhat run scripts/deploy.js --network sepolia
```

## What's verified vs. what's not

- ✅ Backend installs and runs — `/health` and the (stubbed) `/api/files/upload`
  endpoint were tested and respond correctly in this environment.
- ✅ Frontend installs and builds successfully with Vite.
- ⚠️ The Solidity contract could **not** be compiled in this sandboxed
  environment (it needs to download the compiler binary from
  `binaries.soliditylang.org`, which this container can't reach). The code
  follows standard, well-tested Hardhat/Solidity patterns, but run
  `npx hardhat compile && npx hardhat test` yourself first thing to confirm —
  don't treat it as verified until you've seen it pass locally.

## What's intentionally NOT built yet

  Implemented` on purpose rather than faking success
- Writing the CID to the blockchain from the frontend (Phase 5)
- Download + decryption (Phase 6)
- Share/revoke UI wired to the contract (Phase 7)
- Full dashboard (Phase 8)

## Phase 3: client-side encryption (done)

- `frontend/src/utils/crypto.js`: AES-256-GCM via the Web Crypto API (per-file random key + random 12-byte IV).
- `frontend/src/components/FileEncryption.jsx`: local "Secure File Encryption" test UI.
- `cd frontend && npm test` runs the 33 encryption tests.
- The key lives in page memory only. Refreshing the page loses it. There is no key backup or sharing yet (needs a later phase).

## Phase 4: IPFS storage (done)

```
Browser: encrypt (AES-256-GCM) -> POST encrypted container -> backend -> Kubo node (IPFS, pinned)
Browser: GET /api/storage/:cid  <- backend streams the container <- Kubo
Browser: unpack + decrypt with the in-memory key
```

**Provider:** a local [Kubo](https://docs.ipfs.tech/install/command-line/) node via its HTTP RPC API, behind a provider interface
(`backend/providers/`, `frontend/src/services/storageService.js`). No credentials are needed for local development.

### Run it
```bash
# 1. IPFS node (separate terminal; install Kubo first, see link above)
ipfs init            # first time only
ipfs daemon          # RPC API on 127.0.0.1:5001 (keep it local-only)

# 2. Backend
cd backend
npm install
cp .env.example .env          # skip if you already have one; add the IPFS_* / CORS_ORIGIN variables from the example
npm run dev                   # http://localhost:5000
curl http://localhost:5000/api/storage/health   # expect {"status":"ok",...,"reachable":true}

# 3. Frontend
cd ../frontend
npm install
cp .env.example .env          # skip if you already have one; add VITE_BACKEND_URL=http://localhost:5000
npm run dev
```

### API
| Endpoint | Purpose |
|---|---|
| `POST /api/storage/upload` | multipart field `file` = encrypted container. `201 {cid,size,provider,metadata}` only after IPFS confirms. |
| `GET /api/storage/:cid` | streams the encrypted container (validated CID; refuses non-container content) |
| `GET /api/storage/:cid/info` | size of the stored object |
| `GET /api/storage/health` | `200` if the IPFS node is reachable, else `503` |

Errors: `400` invalid CID/request, `404` not found, `413` too large, `422` not an encrypted container, `429` rate limited,
`502/503/504` provider misconfigured/unavailable/timed out. Bodies are `{error, code}`; no stack traces or secrets.

### Tests
```bash
cd backend && npm test      # node:test + supertest, mock provider and mock Kubo server
cd frontend && npm test     # vitest (+ jsdom/Testing Library)
```

### Security notes
- Only encrypted containers are accepted (strict header allowlist), so plaintext and key-bearing metadata are rejected server-side.
- The encryption key never leaves the browser and is never stored. Closing the page loses it.
- IPFS is public: anyone with a CID can fetch the encrypted file, and the file name, MIME type and size sit in its unencrypted header.
- The API has **no authentication** (only CORS allow-list, rate limiting, size limits). Do not expose it publicly as-is.
- Kubo `add` pins on your node only. That is not replicated or guaranteed permanent storage.
