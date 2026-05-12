import { HDKey } from "@scure/bip32";
import { base58check, bech32 } from "@scure/base";
import { sha256 } from "@noble/hashes/sha2.js";
import { ripemd160 } from "@noble/hashes/legacy.js";

const xpub = process.env.TXC_XPUB;
const raw = base58check(sha256).decode(xpub);
const v = ((raw[0]<<24)|(raw[1]<<16)|(raw[2]<<8)|raw[3])>>>0;
const acct = HDKey.fromExtendedKey(xpub, { private:0, public:v });
const ext = acct.deriveChild(0);

function addr(pub){ const h=ripemd160(sha256(pub)); return bech32.encode("txc",[0,...bech32.toWords(h)]); }
const addrs = [];
for (let i=0;i<5;i++) addrs.push(addr(ext.deriveChild(i).publicKey));
console.log("derived m/0/0..4:");
addrs.forEach((a,i)=>console.log(` ${i}: ${a}`));

// Validate each against the node
const url = "http://44.201.92.162:15739";
const auth = Buffer.from(`${process.env.rpcuser}:${process.env.rpcpassword}`).toString("base64");
async function rpc(m,p=[]){const r=await fetch(url,{method:"POST",headers:{"Content-Type":"application/json",Authorization:`Basic ${auth}`},body:JSON.stringify({jsonrpc:"1.0",id:"x",method:m,params:p})});return JSON.parse(await r.text());}
console.log("\nNode validation:");
for (const a of addrs) {
  const v = await rpc("validateaddress",[a]);
  console.log(` ${a} -> isvalid=${v.result?.isvalid} iswitness=${v.result?.iswitness} v=${v.result?.witness_version}`);
}
