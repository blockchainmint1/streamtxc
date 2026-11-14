// The one place the platform admin wallet is defined. Server checks compare
// against the session-verified wallet, never a client-supplied value.
export const ADMIN_WALLET = "TmmoqqhcfBZWRG8feCTE2c4N4BsADgwD1m";

export function isAdminWallet(wallet: string | null | undefined): boolean {
  return !!wallet && wallet === ADMIN_WALLET;
}
