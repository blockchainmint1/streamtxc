import { HDKey } from "@scure/bip32";
import { base58check, bech32 } from "@scure/base";
import { sha256 } from "@noble/hashes/sha2.js";
import { ripemd160 } from "@noble/hashes/legacy.js";

const url = "http://44.201.92.162:15739";
const auth = Buffer.from(`${process.env.rpcuser}:${process.env.rpcpassword}`).toString("base64");
async function rpc(method, params=[]) {
  const r = await fetch(url, { method:"POST", headers:{ "Content-Type":"application/json", Authorization:`Basic ${auth}`}, body: JSON.stringify({jsonrpc:"1.0",id:"x",method,params}) });
  const j = JSON.parse(await r.text());
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}

// Derive m/0/0 from the zpub as our video wallet for this test
const xpub = process.env.TXC_XPUB;
const raw = base58check(sha256).decode(xpub);
const ver = ((raw[0]<<24)|(raw[1]<<16)|(raw[2]<<8)|raw[3])>>>0;
const acct = HDKey.fromExtendedKey(xpub, { private:0, public:ver });
const ext = acct.deriveChild(0);
function p2wpkh(pub){ const h=ripemd160(sha256(pub)); return bech32.encode("txc",[0,...bech32.toWords(h)]); }
const videoAddr = p2wpkh(ext.deriveChild(0).publicKey);
console.log("Video wallet (m/0/0):", videoAddr);

// Build OP_RETURN payload: TXCV1C|<cid>|<wallet-prefix>
const cid = "bafybeiao744epakt3ezti73tdurvhutkgtxvuz6gtlc6i7rlxg5hmwekxm";
const ownerWallet = "0x9e780595fc5bbd31ae6e60da40f3d78440424312";
const payload = `TXCV1C|${cid}|${ownerWallet.slice(0,12)}`;
const dataHex = Buffer.from(payload, "utf8").toString("hex");
console.log("Payload:", payload, `(${Buffer.byteLength(payload)} bytes)`);

// createraw → fund → sign → send
const rawTx = await rpc("createrawtransaction", [[], [{ data: dataHex }, { [videoAddr]: 0.0001 }]]);
console.log("raw built");
const funded = await rpc("fundrawtransaction", [rawTx]);
console.log("funded, fee:", funded.fee);
const signed = await rpc("signrawtransactionwithwallet", [funded.hex]);
if (!signed.complete) throw new Error("sign incomplete");
console.log("signed");
const txid = await rpc("sendrawtransaction", [signed.hex]);
console.log("\n🎉 TXID:", txid);
console.log("Mempool URL: https://mempool.texitcoin.org/tx/" + txid);
console.log("Address URL: https://mempool.texitcoin.org/address/" + videoAddr);
