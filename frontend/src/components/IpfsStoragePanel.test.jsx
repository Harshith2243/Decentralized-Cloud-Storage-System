// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { webcrypto } from "node:crypto";
import { File as NodeFile } from "node:buffer";
import FileEncryption from "./FileEncryption";
import { isValidCID } from "../utils/cid";
import { encryptFile, packEncryptedFile } from "../utils/crypto";

// jsdom has no Web Crypto subtle API or object URLs; use Node's implementations.
Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });

const CID = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
const OTHER_CID = "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG";
const PLAINTEXT = "hello from the component test ✓";

function makeStorage(over = {}) {
  const store = new Map();
  return {
    store,
    validateCID: isValidCID,
    uploadEncryptedFile: vi.fn(async (bytes) => {
      store.set(CID, new Uint8Array(bytes));
      return { cid: CID, size: bytes.length };
    }),
    retrieveEncryptedFile: vi.fn(async (cid) => {
      if (!store.has(cid)) throw new Error("No content was found for that CID.");
      return store.get(cid);
    }),
    ...over,
  };
}

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

async function selectAndEncrypt(name = "notes.txt") {
  const file = new NodeFile([new TextEncoder().encode(PLAINTEXT)], name, { type: "text/plain" });
  fireEvent.change(screen.getByLabelText("Select a file to encrypt"), { target: { files: [file] } });
  fireEvent.click(screen.getByRole("button", { name: "Encrypt File" }));
  await screen.findByText("Encryption completed");
  return file;
}

const click = (name) => fireEvent.click(screen.getByRole("button", { name }));

beforeEach(() => {
  URL.createObjectURL = vi.fn(() => "blob:mock");
  URL.revokeObjectURL = vi.fn();
  Object.defineProperty(navigator, "clipboard", { value: { writeText: vi.fn(async () => {}) }, configurable: true });
});
afterEach(cleanup);

describe("upload", () => {
  it("is disabled until a file is encrypted, then shows each state", async () => {
    render(<FileEncryption storage={makeStorage()} />);
    expect(screen.getByRole("button", { name: "Upload Encrypted File to IPFS" }).disabled).toBe(true);
    expect(screen.getByText("No file selected")).toBeTruthy();

    const file = new NodeFile([new Uint8Array([1, 2, 3])], "a.bin");
    fireEvent.change(screen.getByLabelText("Select a file to encrypt"), { target: { files: [file] } });
    expect(screen.getByText("File selected")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Encrypt File" }));
    await screen.findByText("Encryption completed");
    expect(screen.getByRole("button", { name: "Upload Encrypted File to IPFS" }).disabled).toBe(false);
  });

  it("shows 'in progress', disables controls, and only reports success after confirmation", async () => {
    const d = deferred();
    const storage = makeStorage({ uploadEncryptedFile: vi.fn(() => d.promise) });
    render(<FileEncryption storage={storage} />);
    await selectAndEncrypt();

    click("Upload Encrypted File to IPFS");
    expect(await screen.findByText("Upload in progress")).toBeTruthy();
    expect(screen.queryByText("Upload successful")).toBeNull(); // not successful before the provider confirms
    expect(screen.getByLabelText("Select a file to encrypt").disabled).toBe(true);
    expect(screen.getByRole("button", { name: "Encrypt File" }).disabled).toBe(true);

    d.resolve({ cid: CID, size: 1 });
    expect(await screen.findByText("Upload successful")).toBeTruthy();
    expect(screen.getByTestId("uploaded-cid").textContent).toBe(CID);
    expect(screen.getByLabelText("Select a file to encrypt").disabled).toBe(false);
  });

  it("uploads exactly the encrypted container: no plaintext and no key reach the storage client", async () => {
    const storage = makeStorage();
    render(<FileEncryption storage={storage} />);
    await selectAndEncrypt();
    click("Upload Encrypted File to IPFS");
    await screen.findByText("Upload successful");

    const [bytes, opts] = storage.uploadEncryptedFile.mock.calls[0];
    expect(storage.uploadEncryptedFile.mock.calls[0]).toHaveLength(2);
    expect(Object.keys(opts)).toEqual(["onProgress"]);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(bytes.slice(0, 8))).toBe("DCSENC01");
    expect(Buffer.from(bytes).includes(Buffer.from(PLAINTEXT))).toBe(false);
  });

  it("shows a clear error and never a CID when the upload fails", async () => {
    const storage = makeStorage({ uploadEncryptedFile: vi.fn(async () => { throw new Error("The IPFS storage service is unavailable. Nothing was uploaded."); }) });
    render(<FileEncryption storage={storage} />);
    await selectAndEncrypt();
    click("Upload Encrypted File to IPFS");
    expect(await screen.findByText(/Nothing was uploaded/)).toBeTruthy();
    expect(screen.getByText("Operation failed")).toBeTruthy();
    expect(screen.queryByText("Upload successful")).toBeNull();
    expect(screen.queryByTestId("uploaded-cid")).toBeNull();
    // user can retry
    expect(screen.getByRole("button", { name: "Upload Encrypted File to IPFS" }).disabled).toBe(false);
  });

  it("copies the CID, and reports clipboard failures", async () => {
    render(<FileEncryption storage={makeStorage()} />);
    await selectAndEncrypt();
    click("Upload Encrypted File to IPFS");
    await screen.findByText("Upload successful");

    click("Copy CID");
    await screen.findByText(/Copied\./);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(CID);

    navigator.clipboard.writeText = vi.fn(async () => { throw new Error("denied"); });
    click("Copy CID");
    expect(await screen.findByText(/Copy failed/)).toBeTruthy();
  });
});

describe("retrieval and decryption", () => {
  it("rejects an invalid CID without calling storage", async () => {
    const storage = makeStorage();
    render(<FileEncryption storage={storage} />);
    fireEvent.change(screen.getByLabelText("CID to retrieve"), { target: { value: "not-a-cid" } });
    click("Retrieve from IPFS");
    expect(await screen.findByText(/Invalid CID/)).toBeTruthy();
    expect(storage.retrieveEncryptedFile).not.toHaveBeenCalled();
    expect(screen.getByText("Operation failed")).toBeTruthy();
  });

  it("shows retrieval failures", async () => {
    const storage = makeStorage();
    render(<FileEncryption storage={storage} />);
    fireEvent.change(screen.getByLabelText("CID to retrieve"), { target: { value: OTHER_CID } });
    click("Retrieve from IPFS");
    expect(await screen.findByText(/No content was found/)).toBeTruthy();
  });

  it("upload -> retrieve -> decrypt: verified against the original, with downloads", async () => {
    const storage = makeStorage();
    render(<FileEncryption storage={storage} />);
    await selectAndEncrypt("report.txt");
    click("Upload Encrypted File to IPFS");
    await screen.findByText("Upload successful");

    expect((screen.getByLabelText("CID to retrieve")).value).toBe(CID); // prefilled from the upload
    click("Retrieve from IPFS");
    expect(await screen.findByText("Retrieval successful")).toBeTruthy();
    expect(screen.getByText("Download Retrieved Encrypted File")).toBeTruthy();

    click("Decrypt Retrieved File");
    expect(await screen.findByText("Decryption successful")).toBeTruthy();
    expect(screen.getByText(/SHA-256 verified/)).toBeTruthy();
    const link = screen.getByText("Download Retrieved Decrypted File");
    expect(link.getAttribute("download")).toBe("report.txt");
    expect(link.getAttribute("href")).toBe("blob:mock");
  });

  it("does not claim verification when there is no reference for that CID", async () => {
    const storage = makeStorage();
    render(<FileEncryption storage={storage} />);
    await selectAndEncrypt();
    click("Upload Encrypted File to IPFS");
    await screen.findByText("Upload successful");
    storage.store.set(OTHER_CID, storage.store.get(CID)); // same bytes under a CID we did not upload in this session

    fireEvent.change(screen.getByLabelText("CID to retrieve"), { target: { value: OTHER_CID } });
    click("Retrieve from IPFS");
    await screen.findByText("Retrieval successful");
    click("Decrypt Retrieved File");
    expect(await screen.findByText(/No original reference hash/)).toBeTruthy();
    expect(screen.queryByText(/SHA-256 verified/)).toBeNull();
  });

  it("fails clearly when the retrieved file was encrypted with a different key", async () => {
    const storage = makeStorage();
    render(<FileEncryption storage={storage} />);
    await selectAndEncrypt();
    const foreign = await encryptFile(new NodeFile([new TextEncoder().encode("someone else's file")], "x.txt"));
    storage.store.set(OTHER_CID, packEncryptedFile(foreign.encryptedData, foreign.metadata));

    fireEvent.change(screen.getByLabelText("CID to retrieve"), { target: { value: OTHER_CID } });
    click("Retrieve from IPFS");
    await screen.findByText("Retrieval successful");
    click("Decrypt Retrieved File");
    expect(await screen.findByText(/Decryption failed: wrong key/)).toBeTruthy();
    expect(screen.queryByText("Decryption successful")).toBeNull();
    expect(screen.queryByText("Download Retrieved Decrypted File")).toBeNull();
  });

  it("rejects retrieved data that is not a valid encrypted container", async () => {
    const storage = makeStorage();
    storage.store.set(OTHER_CID, new TextEncoder().encode("just some random public IPFS content"));
    render(<FileEncryption storage={storage} />);
    fireEvent.change(screen.getByLabelText("CID to retrieve"), { target: { value: OTHER_CID } });
    click("Retrieve from IPFS");
    expect(await screen.findByText(/not a valid encrypted file/)).toBeTruthy();
    expect(screen.queryByText("Retrieval successful")).toBeNull();
  });

  it("cannot decrypt without a key in memory, and says so", async () => {
    const storage = makeStorage();
    const { encryptedData, metadata } = await encryptFile(new NodeFile([new Uint8Array([9, 9, 9])], "k.bin"));
    storage.store.set(OTHER_CID, packEncryptedFile(encryptedData, metadata));
    render(<FileEncryption storage={storage} />); // fresh page: no key
    fireEvent.change(screen.getByLabelText("CID to retrieve"), { target: { value: OTHER_CID } });
    click("Retrieve from IPFS");
    await screen.findByText("Retrieval successful");
    expect(screen.getByText(/No encryption key is in memory/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Decrypt Retrieved File" }).disabled).toBe(true);
  });

  it("states the privacy and key limitations", () => {
    render(<FileEncryption storage={makeStorage()} />);
    expect(screen.getByText(/IPFS is public/)).toBeTruthy();
    expect(screen.getByText(/CID alone cannot decrypt/)).toBeTruthy();
  });
});

describe("Phase 5: blockchain recording", () => {
  it("renders Save CID to Blockchain button after upload", async () => {
    render(<FileEncryption storage={makeStorage()} />);
    await selectAndEncrypt("document.pdf");
    click("Upload Encrypted File to IPFS");
    await screen.findByText("Upload successful");
    expect(screen.getByRole("button", { name: "Save CID to Blockchain" })).toBeTruthy();
  });

  it("shows an error when Save CID to Blockchain is clicked without a connected wallet", async () => {
    render(<FileEncryption storage={makeStorage()} account={null} />);
    await selectAndEncrypt("document.pdf");
    click("Upload Encrypted File to IPFS");
    await screen.findByText("Upload successful");

    click("Save CID to Blockchain");
    expect(await screen.findByText("Wallet not connected. Connect your MetaMask wallet first.")).toBeTruthy();
    expect(screen.getByText("Operation failed")).toBeTruthy();
  });

  it("shows an error when on wrong network", async () => {
    render(
      <FileEncryption
        storage={makeStorage()}
        account="0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
        isWrongNetwork={true}
      />
    );
    await selectAndEncrypt("document.pdf");
    click("Upload Encrypted File to IPFS");
    await screen.findByText("Upload successful");

    click("Save CID to Blockchain");
    expect(await screen.findByText("Wrong network. Please switch MetaMask to Hardhat Local (chain ID 31337).")).toBeTruthy();
  });

  it("records file on blockchain and displays tx hash and fileId", async () => {
    const mockTx = {
      hash: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
      wait: vi.fn(async () => ({
        hash: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
        logs: [
          {
            topics: ["0xFileUploadedTopic"],
            data: "0x...",
          },
        ],
      })),
    };
    const mockContract = {
      uploadFile: vi.fn(async () => mockTx),
      interface: {
        parseLog: vi.fn(() => ({
          name: "FileUploaded",
          args: [1n, "0xf39..."],
        })),
      },
    };

    render(
      <FileEncryption
        storage={makeStorage()}
        account="0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
        isWrongNetwork={false}
        contract={mockContract}
      />
    );
    const file = await selectAndEncrypt("testfile.txt");
    click("Upload Encrypted File to IPFS");
    await screen.findByText("Upload successful");

    click("Save CID to Blockchain");
    expect(mockContract.uploadFile).toHaveBeenCalledWith(CID, "testfile.txt", file.size);
    expect(await screen.findByText(/Recorded on Blockchain!/)).toBeTruthy();
    expect(screen.getByText(/File ID: #1/)).toBeTruthy();
    expect(screen.getByText(/0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef/)).toBeTruthy();
    expect(screen.getByText("Recorded on blockchain")).toBeTruthy();
  });

  it("handles transaction rejection gracefully", async () => {
    const mockContract = {
      uploadFile: vi.fn(async () => {
        const err = new Error("user rejected transaction");
        err.code = 4001;
        throw err;
      }),
    };

    render(
      <FileEncryption
        storage={makeStorage()}
        account="0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
        isWrongNetwork={false}
        contract={mockContract}
      />
    );
    await selectAndEncrypt("testfile.txt");
    click("Upload Encrypted File to IPFS");
    await screen.findByText("Upload successful");

    click("Save CID to Blockchain");
    expect(await screen.findByText(/Transaction was rejected/)).toBeTruthy();
    expect(screen.getByText("Operation failed")).toBeTruthy();
  });

  it("handles contract call errors gracefully", async () => {
    const mockContract = {
      uploadFile: vi.fn(async () => {
        const err = new Error("FileStorage: CID cannot be empty");
        err.reason = "FileStorage: CID cannot be empty";
        throw err;
      }),
    };

    render(
      <FileEncryption
        storage={makeStorage()}
        account="0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
        isWrongNetwork={false}
        contract={mockContract}
      />
    );
    await selectAndEncrypt("testfile.txt");
    click("Upload Encrypted File to IPFS");
    await screen.findByText("Upload successful");

    click("Save CID to Blockchain");
    expect(await screen.findByText(/FileStorage: CID cannot be empty/)).toBeTruthy();
    expect(screen.getByText("Operation failed")).toBeTruthy();
  });
});

