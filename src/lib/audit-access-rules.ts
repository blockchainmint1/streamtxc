export function branchIdentityMatches(wallet: string, identity: string): boolean {
  return wallet === identity;
}

/** Client preferences never override the requirement for a mined payment. */
export function renewalPaymentConfirmed(status: { confirmed?: boolean } | undefined): boolean {
  return status?.confirmed === true;
}