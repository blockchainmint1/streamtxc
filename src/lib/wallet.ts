// Mock wallet for the MVP. Generates a persistent fake EVM-style address
// stored in localStorage so the rest of the app can treat it like a real wallet.
// Swap in wagmi + injected provider when TXC chain is live.

import { useEffect, useState, useCallback } from "react";

const STORAGE_KEY = "txc:mockwallet";

function randomAddress(): string {
  const hex = "0123456789abcdef";
  let out = "0x";
  for (let i = 0; i < 40; i++) out += hex[Math.floor(Math.random() * 16)];
  return out;
}

export function getWallet(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(STORAGE_KEY);
}

export function connectWallet(): string {
  const existing = getWallet();
  if (existing) return existing;
  const addr = randomAddress();
  window.localStorage.setItem(STORAGE_KEY, addr);
  window.dispatchEvent(new Event("txc:wallet-changed"));
  return addr;
}

export function disconnectWallet() {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(STORAGE_KEY);
  window.dispatchEvent(new Event("txc:wallet-changed"));
}

export function useWallet() {
  const [address, setAddress] = useState<string | null>(null);

  useEffect(() => {
    setAddress(getWallet());
    const handler = () => setAddress(getWallet());
    window.addEventListener("txc:wallet-changed", handler);
    window.addEventListener("storage", handler);
    return () => {
      window.removeEventListener("txc:wallet-changed", handler);
      window.removeEventListener("storage", handler);
    };
  }, []);

  const connect = useCallback(() => {
    const a = connectWallet();
    setAddress(a);
    return a;
  }, []);

  const disconnect = useCallback(() => {
    disconnectWallet();
    setAddress(null);
  }, []);

  return { address, connect, disconnect };
}