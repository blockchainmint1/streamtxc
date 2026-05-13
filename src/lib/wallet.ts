// TXC wallet client (LTC clone — no browser-injected wallet exists yet).
// The user's "wallet" is a TXC base58 address they paste in after signing
// a challenge in their TXC Core / mobile wallet. No address is invented:
// `address` is null until the user explicitly connects.

import { useEffect, useState, useCallback } from "react";

const STORAGE_KEY = "txc:wallet";

/**
 * TXC follows Litecoin's address format: legacy base58 (L…/M…/3…/T…),
 * base58 P2SH, or bech32 (`txc1…` / `ltc1…`). We accept any reasonable
 * 20–90 char alnum-ish string — the real validation happens server-side
 * via the node's `verifymessage` RPC during signature verification.
 * Legacy 0x… mock addresses from earlier builds are also accepted so
 * existing localStorage entries don't break.
 */
export function isValidTxcAddress(addr: string): boolean {
  const s = addr.trim();
  if (/^0x[a-fA-F0-9]{40}$/.test(s)) return true;
  return /^[a-zA-Z0-9]{20,90}$/.test(s);
}

interface StoredWallet {
  address: string;
  signature?: string;
}

function read(): StoredWallet | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as StoredWallet;
    if (parsed && typeof parsed.address === "string") return parsed;
    return null;
  } catch {
    // Backwards-compat: old builds stored the bare address string.
    return { address: raw };
  }
}

function write(next: StoredWallet | null) {
  if (typeof window === "undefined") return;
  if (next) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } else {
    window.localStorage.removeItem(STORAGE_KEY);
  }
  window.dispatchEvent(new Event("txc:wallet-changed"));
}

export function getWallet(): string | null {
  return read()?.address ?? null;
}

export function setVerifiedWallet(address: string, signature?: string) {
  if (!isValidTxcAddress(address)) {
    throw new Error("That doesn't look like a valid TXC address");
  }
  write({ address: address.trim(), signature });
}

export function disconnectWallet() {
  write(null);
}

export function useWallet() {
  const [stored, setStored] = useState<StoredWallet | null>(null);

  useEffect(() => {
    setStored(read());
    const handler = () => setStored(read());
    window.addEventListener("txc:wallet-changed", handler);
    window.addEventListener("storage", handler);
    return () => {
      window.removeEventListener("txc:wallet-changed", handler);
      window.removeEventListener("storage", handler);
    };
  }, []);

  const connect = useCallback((address: string, signature?: string) => {
    setVerifiedWallet(address, signature);
    setStored({ address: address.trim(), signature });
  }, []);

  const disconnect = useCallback(() => {
    disconnectWallet();
    setStored(null);
  }, []);

  return {
    address: stored?.address ?? null,
    signature: stored?.signature ?? null,
    connect,
    disconnect,
  };
}

/** Header chip helper: drop the leading prefix char and take 6 of the rest. */
export function shortWalletId(address: string): string {
  const stripped = address.startsWith("0x") ? address.slice(2) : address.slice(1);
  return stripped.slice(0, 6);
}