/// <reference types="bun" />
import { afterEach, expect, test } from "bun:test";
import { branchIdentityMatches, renewalPaymentConfirmed, publicTranscodeError, publicJobSummary } from "./audit-access-rules";
import { authDomainFromRequest, publicOriginFromRequest, buildSignableMessage, matchesSignableMessage } from "./wallet-auth-shared";
import { issueWalletBrowserProof, verifyWalletBrowserProof } from "./wallet-auth.server";
import { verifyMessage } from "./txc.server";

const owner = "TmmoqqhcfBZWRG8feCTE2c4N4BsADgwD1m";
const other = "TgCKcnxHJiLrBgDXHNx8jM4FBuNK7k63Jd";
const secret = process.env.SUPABASE_SERVICE_ROLE_KEY;
const rpcUrl = process.env.TXC_RPC_URL;
afterEach(() => {
  if (secret === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  else process.env.SUPABASE_SERVICE_ROLE_KEY = secret;
  if (rpcUrl === undefined) delete process.env.TXC_RPC_URL;
  else process.env.TXC_RPC_URL = rpcUrl;
});

test("branch sharing requires the exact requesting wallet", () => {
  expect(branchIdentityMatches(owner, owner)).toBe(true);
  expect(branchIdentityMatches(owner, other)).toBe(false);
  expect(branchIdentityMatches(owner, owner.toLowerCase())).toBe(false);
});
test("renewals require confirmed payments, not merely mempool presence", () => {
  expect(renewalPaymentConfirmed({ confirmed: false })).toBe(false);
  expect(renewalPaymentConfirmed(undefined)).toBe(false);
  expect(renewalPaymentConfirmed({ confirmed: true })).toBe(true);
});
test("wallet sign-in cannot be renamed by headers or query", () => {
  const req = new Request("https://streamtxc.com/api/public/auth/wallet-callback?domain=evil.example", { headers: { origin: "https://evil.example", referer: "https://evil.example", "x-forwarded-host": "evil.example" } });
  expect(authDomainFromRequest(req)).toBe("streamtxc.com");
  expect(publicOriginFromRequest(req)).toBe("https://streamtxc.com");
});
test("nonce alone is insufficient; only the issued message is accepted", () => {
  const expected = buildSignableMessage({ nonce: "test-nonce", domain: "streamtxc.com", issuedAt: "2026-11-11T18:34:00Z" });
  expect(matchesSignableMessage("Verify your age\nNonce: test-nonce", expected)).toBe(false);
  expect(matchesSignableMessage(expected + "\nSend money", expected)).toBe(false);
  expect(matchesSignableMessage(expected.replace(/\n/g, "\r\n"), expected)).toBe(true);
});
test("browser proof is bound to one challenge and expires", async () => {
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-only-signing-secret";
  const proof = await issueWalletBrowserProof("first", new Date(Date.now() + 60_000).toISOString());
  expect(await verifyWalletBrowserProof(proof, "first")).toBe(true);
  expect(await verifyWalletBrowserProof(proof, "second")).toBe(false);
  expect(await verifyWalletBrowserProof(null, "first")).toBe(false);
  expect(await verifyWalletBrowserProof(proof + "changed", "first")).toBe(false);
  const expired = await issueWalletBrowserProof("first", new Date(Date.now() - 60_000).toISOString());
  expect(await verifyWalletBrowserProof(expired, "first")).toBe(false);
});
test("missing RPC cannot turn a fabricated signature into wallet access", async () => {
  delete process.env.TXC_RPC_URL;
  expect(await verifyMessage(owner, "fake-signature-eight-characters", "Sign in")).toBe(false);
});
test("conversion errors show raw details only to the video's owner", () => {
  expect(publicTranscodeError("AccessDenied arn:aws:s3:::bucket/inputs/x", false)).toBe("Video conversion failed.");
  expect(publicTranscodeError("AccessDenied arn:aws:s3:::bucket/inputs/x", true)).toBe("AccessDenied arn:aws:s3:::bucket/inputs/x");
  expect(publicTranscodeError(null, false)).toBeNull();
});
test("job lookups return only status and progress", () => {
  const out = publicJobSummary({ job: { status: "ERROR", jobPercentComplete: 40, errorMessage: "s3://secret-bucket/key", id: "arn:aws:x" } as never });
  expect(out).toEqual({ job: { status: "ERROR", jobPercentComplete: 40 } });
});
