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

/**
 * The current TXC "Sign message" verification flow only works with
 * legacy base58 addresses that start with T. Native segwit `txc1...`
 * addresses need a different signing standard (BIP-322), which the
 * current wallet/node flow does not support yet.
 */
export function isSignableOwnershipTxcAddress(addr: string): boolean {
  return /^T[1-9A-HJ-NP-Za-km-z]{20,90}$/.test(addr.trim());
}

interface StoredWallet {
  address: string;
  /** Session JWT issued by completeWalletLogin. Required for any
   *  ownership-gated server fn (edit, hide, flag, payout retry, …). */
  token?: string;
  /** Unix seconds. UI uses this to decide whether to prompt a re-sign. */
  expiresAt?: number;
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

export function setWalletSession(args: {
  address: string;
  token: string;
  expiresAt: number;
}) {
  if (!isValidTxcAddress(args.address)) {
    throw new Error("That doesn't look like a valid TXC address");
  }
  write({
    address: args.address.trim(),
    token: args.token,
    expiresAt: args.expiresAt,
  });
}

export function getWalletToken(): string | null {
  const s = read();
  if (!s?.token || !s.expiresAt) return null;
  if (s.expiresAt * 1000 < Date.now()) return null;
  return s.token;
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
    // Legacy unverified path. Kept for back-compat with anon upload UX where
    // the user just labels their uploads with an address. Does NOT issue a
    // session token — gated mutations will still 401 until the user signs
    // through the new Header dialog.
    write({ address: address.trim(), signature });
    setStored(read());
  }, []);

  const completeLogin = useCallback(
    (args: { address: string; token: string; expiresAt: number }) => {
      setWalletSession(args);
      setStored(read());
    },
    [],
  );

  const disconnect = useCallback(() => {
    disconnectWallet();
    setStored(null);
  }, []);

  return {
    address: stored?.address ?? null,
    signature: stored?.signature ?? null,
    token: stored?.token ?? null,
    isAuthenticated: !!stored?.token && !!stored.expiresAt && stored.expiresAt * 1000 > Date.now(),
    connect,
    completeLogin,
    disconnect,
  };
}

/** Header chip helper: drop the leading prefix char and take 6 of the rest. */
export function shortWalletId(address: string): string {
  const stripped = address.startsWith("0x") ? address.slice(2) : address.slice(1);
  return stripped.slice(0, 6);
}