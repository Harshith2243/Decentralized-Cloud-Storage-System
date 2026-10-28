// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { webcrypto } from "node:crypto";
import App from "./App";
import { WalletProvider } from "./context/WalletContext";

Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
afterEach(cleanup);

describe("existing UI is preserved", () => {
  it("still renders the wallet header and the encryption section", () => {
    render(<WalletProvider><App /></WalletProvider>);
    expect(screen.getByText("Decentralized Cloud Storage")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Connect Wallet" })).toBeTruthy();
    expect(screen.getByText("Secure File Encryption")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Encrypt File" })).toBeTruthy();
  });
});
