import { HDKey } from "@scure/bip32";
import { base58check } from "@scure/base";
import { sha256 } from "@noble/hashes/sha2";
import { ripemd160 } from "@noble/hashes/legacy";

const xpub = process.env.TXC_XPUB;
if (!xpub) { console.error("no TXC_XPUB"); process.exit(1); }
const VER = process.env.TXC_P2PKH_VERSION ? Number(process.env.TXC_P2PKH_VERSION) : 0x41;
const b58c = base58check(sha256);

function addr(pub) {
  const h = ripemd160(sha256(pub));
  const p = new Uint8Array(21);
  p[0] = VER & 0xff;
  p.set(h, 1);
  return b58c.encode(p);
}

const acct = HDKey.fromExtendedKey(xpub);
console.log("xpub depth:", acct.depth, "index:", acct.index);

// Try interpreting as account-level (m/44'/c'/0') -> derive /0/i
console.log("\nAssuming account-level xpub, deriving m/0/i:");
const ext = acct.deriveChild(0);
for (let i = 0; i < 5; i++) {
  console.log(`  m/0/${i} =>`, addr(ext.deriveChild(i).publicKey));
}

// Also try as if xpub is already external chain -> derive /i directly
console.log("\nAssuming external-chain xpub, deriving m/i:");
for (let i = 0; i < 5; i++) {
  console.log(`  m/${i} =>`, addr(acct.deriveChild(i).publicKey));
}
