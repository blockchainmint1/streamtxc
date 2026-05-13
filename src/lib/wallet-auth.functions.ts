import { createServerFn, createMiddleware } from "@tanstack/react-start";
import { getRequestHeader } from "@tanstack/react-start/server";
import { z } from "zod";
import {
  issueChallengeToken,
  issueSessionToken,
  verifyChallengeToken,
  verifySessionToken,
} from "./wallet-auth.server";
import { verifyMessage } from "./txc.server";

// Same shape as videos.functions.ts — "T…" base58 only, since that's what
// TXC Core's "Sign Message" can produce a verifiable signature for.
const signableWalletSchema = z
  .string()
  .trim()
  .regex(
    /^T[1-9A-HJ-NP-Za-km-z]{20,90}$/,
    "Wallet must be a legacy TXC address starting with T",
  );

function buildLoginMessage(wallet: string, nonce: string): string {
  return `streamtxc-login:${wallet}:${nonce}`;
}

function normalizeSignature(signature: string): string {
  return signature.replace(/\s+/g, "");
}

/**
 * Step 1 of wallet login. Returns the message the user must sign and an
 * opaque challenge token they hand back in step 2. No DB write — challenge
 * state lives entirely inside the signed token (5 min TTL).
 */
export const requestWalletLogin = createServerFn({ method: "POST" })
  .inputValidator((input) =>
    z.object({ wallet: signableWalletSchema }).parse(input),
  )
  .handler(async ({ data }) => {
    const nonce = crypto.randomUUID().replace(/-/g, "");
    const message = buildLoginMessage(data.wallet, nonce);
    const challengeToken = await issueChallengeToken({
      wallet: data.wallet,
      nonce,
      message,
    });
    return { message, challengeToken };
  });

/**
 * Step 2. Verify signature, issue session token. Wallet is taken from the
 * verified challenge claim — NOT from the client payload — so a malicious
 * client can't pair their signature with someone else's address.
 */
export const completeWalletLogin = createServerFn({ method: "POST" })
  .inputValidator((input) =>
    z
      .object({
        challengeToken: z.string().min(20).max(4000),
        signature: z.string().trim().min(8).max(200),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const normalizedSignature = normalizeSignature(data.signature);
    const claims = await verifyChallengeToken(data.challengeToken);
    if (!claims) {
      throw new Error("Login challenge expired — start over.");
    }
    let ok = false;
    try {
      ok = await verifyMessage(claims.wallet, normalizedSignature, claims.message);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error("[completeWalletLogin] verifyMessage threw", reason);
      throw new Error(`Could not verify signature: ${reason}`);
    }
    if (!ok) {
      throw new Error(
        "Signature did not verify against this address. In your wallet's 'Sign message' panel, make sure the address matches and re-paste the signature.",
      );
    }
    const session = await issueSessionToken(claims.wallet);
    return {
      wallet: claims.wallet,
      token: session.token,
      expiresAt: session.expiresAt,
    };
  });

/**
 * Server-fn middleware for any mutation that should be gated by an
 * authenticated wallet. Reads `Authorization: Bearer <token>` (set by the
 * matching client middleware below), verifies the HMAC, and exposes the
 * verified wallet on `context.wallet`. Handlers MUST trust `context.wallet`
 * over any wallet field on the input payload.
 */
export const requireWalletSession = createMiddleware({ type: "function" })
  .client(async ({ next }) => {
    let token: string | null = null;
    if (typeof window !== "undefined") {
      try {
        const raw = window.localStorage.getItem("txc:wallet");
        if (raw) {
          const parsed = JSON.parse(raw) as { token?: string };
          token = parsed?.token ?? null;
        }
      } catch {
        token = null;
      }
    }
    return next({
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
  })
  .server(async ({ next }) => {
    const auth = getRequestHeader("authorization");
    if (!auth || !auth.toLowerCase().startsWith("bearer ")) {
      throw new Error("You must connect a wallet to do that.");
    }
    const claims = await verifySessionToken(auth.slice(7).trim());
    if (!claims) {
      throw new Error("Your wallet session has expired. Reconnect and sign in again.");
    }
    return next({ context: { wallet: claims.wallet } });
  });