declare module "ipfs-only-hash" {
  const Hash: {
    of(
      content: Uint8Array | string,
      opts?: { cidVersion?: 0 | 1; rawLeaves?: boolean; hashAlg?: string },
    ): Promise<string>;
  };
  export default Hash;
}