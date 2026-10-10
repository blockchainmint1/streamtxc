// Shared constants for the streamTXC ⇄ HME Wallet branch-share handshake
// ("hm-link-xpubs", same protocol as Bonfire 1101 / File Fingerprint 1103 /
// Passage 1104). streamTXC owns account branch 1105:
//
//   m / 44' / 696969' / 1105' / 0 / <video index>

export const WALLET_LINK_TYPE = "hm-link-xpubs" as const;
export const WALLET_LINK_VERSION = 1 as const;
export const TXC_COIN_TYPE = 696969;
export const STREAMTXC_ACCOUNT = 1105;
export const BRANCH_XPUB_PATH = `m/44'/${TXC_COIN_TYPE}'/${STREAMTXC_ACCOUNT}'`;
export const IDENTITY_PATH = `m/44'/${TXC_COIN_TYPE}'/0'/0/0`;
export const LINK_TTL_SECONDS = 10 * 60;

export function buildLinkMessage(args: {
  domain: string;
  challenge: string;
  xpub: string;
  path: string;
}): string {
  return [
    "Honest Money - Link wallet",
    "",
    `Domain: ${args.domain}`,
    `Challenge: ${args.challenge}`,
    `Path: ${args.path}`,
    `Xpub: ${args.xpub}`,
    "",
    "Signing this message shares a watch-only public key. It does NOT authorize any transaction or spend any coins.",
  ].join("\n");
}

export function isLikelyXpub(value: string): boolean {
  return /^[a-km-zA-HJ-NP-Z1-9]{100,120}$/.test(value.trim());
}
