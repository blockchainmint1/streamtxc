# Wallet session auth

Replace "type any address into Connect" with: sign once → server issues short-lived token → every mutation server fn pulls the wallet from the token, never the client payload.

## Server pieces

1. **JWT secret**: add `WALLET_AUTH_JWT_SECRET` (I'll request it via add_secret; 32+ random bytes).
2. **`src/lib/wallet-auth.server.ts`** — HS256 sign/verify using Web Crypto (`crypto.subtle`, available on Worker). Payload: `{ wallet, iat, exp }`. TTL: 7 days.
3. **`src/lib/wallet-auth.functions.ts`** — two server fns:
   - `requestWalletLoginChallenge({ wallet })` → stores nonce in a new `wallet_login_challenges` table (cid, wallet, nonce, expires_at), returns the message string to sign.
   - `verifyWalletLoginAndIssueToken({ wallet, signature })` → looks up the latest unexpired nonce, calls existing `verifyMessage(...)`, deletes nonce, returns `{ token, expiresAt }`.
4. **`src/lib/wallet-auth.middleware.ts`** — server-fn middleware `requireWalletAuth`: reads `Authorization: Bearer <token>` from request headers, verifies, puts `{ wallet }` into context. Throws 401 otherwise.

## Client pieces

5. **`src/lib/wallet.ts`** — change `connectWallet` flow:
   - Prompt for address.
   - Call challenge fn → display message → user pastes signature (TXC Core "Sign Message" UX, same as ownership proof).
   - Call verify fn → store `{ wallet, token, expiresAt }` in localStorage.
   - Expose `getWalletToken()` and helper `walletAuthHeaders()`.
6. **`useServerFn` callers** — wrap protected mutations to attach the bearer header via a small client middleware, OR pass the token through standard `headers` option on the fetch call. Cleaner: a thin wrapper hook `useAuthedServerFn`.

## Server fns to gate (drop client-supplied `wallet`, read from context)

- `editVideoMetadata`, `setVideoVisibility`, `setVideoFlagged`, `setVideoExpiry`
- `getMyVideos` (already wallet-scoped, but should use ctx wallet)
- `claimVideoOwnership` related write paths
- Any other mutation in `videos.functions.ts` keyed by `data.wallet`

Read paths that take `wallet` purely as a query filter (public lists) stay public.

## Migration

```sql
create table public.wallet_login_challenges (
  id uuid primary key default gen_random_uuid(),
  wallet text not null,
  nonce text not null,
  message text not null,
  expires_at timestamptz not null default (now() + interval '5 minutes'),
  created_at timestamptz not null default now()
);
create index on public.wallet_login_challenges (wallet, expires_at);
alter table public.wallet_login_challenges enable row level security;
-- no client policies; only server (service role) touches it
```

## Hard dependency

This whole flow calls `verifyMessage` — the same primitive currently failing inside the Worker for ownership proofs. **Login won't work until that's fixed.** Same root-cause fix lands both. I'll keep the new logging from last round to surface the actual error.

## Out of scope (this pass)

- HttpOnly cookie variant (would need a server route to set Set-Cookie; bearer-in-localStorage is simpler and matches existing storage model).
- Refresh tokens — 7-day TTL, re-sign on expiry.
- Per-action signing UX from option 2.

Confirm and I'll ship it.