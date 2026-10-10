// Watch-only address derivation from a member's branch-1105 xpub.
// BIP32 CKDpub on @noble/curves — Worker-safe, non-hardened only, so we can
// mint addresses forever but can never spend.

import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";
import { ripemd160 } from "@noble/hashes/ripemd160";
import { hmac } from "@noble/hashes/hmac";
import bs58checkModule from "bs58check";

interface Bs58Check {
  encode: (b: Uint8Array) => string;
  decode: (s: string) => Uint8Array;
}
const mod = bs58checkModule as unknown as Bs58Check & { default?: Bs58Check };
const bs58check: Bs58Check = mod.default ?? mod;

const TXC_P2PKH_VERSION = 65;

interface ExtendedKey {
  publicKey: Uint8Array;
  chainCode: Uint8Array;
}

function toHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function decodeXpub(xpub: string): ExtendedKey {
  const raw = bs58check.decode(xpub.trim());
  if (raw.length !== 78) throw new Error("Invalid extended public key length");
  const chainCode = raw.subarray(13, 45);
  const publicKey = raw.subarray(45, 78);
  if (publicKey[0] !== 0x02 && publicKey[0] !== 0x03) {
    throw new Error("Extended key is not a public key (xpub required)");
  }
  return { publicKey, chainCode };
}

function ckdPub(parent: ExtendedKey, index: number): ExtendedKey {
  if (index >= 0x80000000) throw new Error("Hardened derivation needs a private key");
  const data = new Uint8Array(37);
  data.set(parent.publicKey, 0);
  data[33] = (index >>> 24) & 0xff;
  data[34] = (index >>> 16) & 0xff;
  data[35] = (index >>> 8) & 0xff;
  data[36] = index & 0xff;
  const I = hmac(sha256, parent.chainCode, data);
  const tweak = BigInt(`0x${toHex(I.subarray(0, 32))}`);
  const point = secp256k1.ProjectivePoint.fromHex(parent.publicKey).add(
    secp256k1.ProjectivePoint.BASE.multiply(tweak % secp256k1.CURVE.n),
  );
  return { publicKey: point.toRawBytes(true), chainCode: I.subarray(32) };
}

function pubKeyToAddress(publicKey: Uint8Array): string {
  const payload = new Uint8Array(21);
  payload[0] = TXC_P2PKH_VERSION;
  payload.set(ripemd160(sha256(publicKey)), 1);
  return bs58check.encode(payload);
}

export function deriveBranchAddress(xpub: string, index: number, change = 0): string {
  return pubKeyToAddress(ckdPub(ckdPub(decodeXpub(xpub), change), index).publicKey);
}

export function assertDerivableXpub(xpub: string): void {
  deriveBranchAddress(xpub, 0);
}
