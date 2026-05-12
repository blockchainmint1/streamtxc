// Mock TXC chain interface. Swap implementation when real RPC is ready;
// the rest of the app calls these functions only.

export interface ChainTimestamp {
  txHash: string;
  blockNumber: number;
  explorerUrl: string;
}

function fakeHash(seed: string): string {
  // Deterministic 0x-prefixed hex from a seed (mock).
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  const base = Math.abs(h).toString(16).padStart(8, "0");
  return "0x" + (base + base + base + base + base + base + base + base).slice(0, 64);
}

export function timestampCid(
  cid: string,
  wallet: string,
  sizeBytes: number,
): ChainTimestamp {
  const seed = `${cid}:${wallet}:${sizeBytes}:${Date.now()}`;
  const txHash = fakeHash(seed);
  // Pretend block number derives from current time (1 block / 5s).
  const blockNumber = Math.floor(Date.now() / 5000);
  return {
    txHash,
    blockNumber,
    explorerUrl: `https://explorer.texitcoin.org/tx/${txHash}`,
  };
}

export function mockPaymentTx(wallet: string, amount: number): string {
  return fakeHash(`pay:${wallet}:${amount}:${Date.now()}:${Math.random()}`);
}