import { HDKey } from "@scure/bip32";
import { base58check, base58 } from "@scure/base";
import { sha256 } from "@noble/hashes/sha2.js";
import { ripemd160 } from "@noble/hashes/legacy.js";

const xpub = process.env.TXC_XPUB;
if (!xpub) { console.error("no TXC_XPUB"); process.exit(1); }
const VER = process.env.TXC_P2PKH_VERSION ? Number(process.env.TXC_P2PKH_VERSION) : 0x41;

console.log("xpub prefix:", xpub.slice(0, 4));
const raw = base58check(sha256).decode(xpub);
const versionBytes = raw.slice(0, 4);
const versionPub = (versionBytes[0]<<24)|(versionBytes[1]<<16)|(versionBytes[2]<<8)|versionBytes[3];
console.log("version bytes (hex):", Buffer.from(versionBytes).toString("hex"), "as int:", versionPub >>> 0);

const acct = HDKey.fromExtendedKey(xpub, { private: 0, public: versionPub >>> 0 });
console.log("depth:", acct.depth, "index:", acct.index, "childIndex:", acct.index);

const b58c = base58check(sha256);
function addr(pub) {
  const h = ripemd160(sha256(pub));
  const p = new Uint8Array(21);
  p[0] = VER & 0xff;
  p.set(h, 1);
  return b58c.encode(p);
}

console.log("\nm/0/i (assuming account-level xpub):");
const ext = acct.deriveChild(0);
for (let i = 0; i < 5; i++) console.log(` ${i}:`, addr(ext.deriveChild(i).publicKey));

console.log("\nm/i (assuming external-chain xpub):");
for (let i = 0; i < 5; i++) console.log(` ${i}:`, addr(acct.deriveChild(i).publicKey));
