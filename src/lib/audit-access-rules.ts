/** Raw AWS/node error text is shown only to the video's owner. */
export function publicTranscodeError(raw: string | null | undefined, isOwner: boolean): string | null {
  if (!raw) return null;
  return isOwner ? raw : "Video conversion failed.";
}

/** Diagnostic job lookups expose only progress, never ARNs, paths or AWS error text. */
export function publicJobSummary(job: { job?: { status?: string; jobPercentComplete?: number } } | null | undefined) {
  return { job: { status: job?.job?.status ?? null, jobPercentComplete: job?.job?.jobPercentComplete ?? null } };
}

export function branchIdentityMatches(wallet: string, identity: string): boolean {
  return wallet === identity;
}

/** Client preferences never override the requirement for a mined payment. */
export function renewalPaymentConfirmed(status: { confirmed?: boolean } | undefined): boolean {
  return status?.confirmed === true;
}