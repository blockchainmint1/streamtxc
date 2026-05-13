## Goal

Stop auto-assigning fake `0x…` EVM addresses. Let users upload anonymously, and offer a "Sign this upload and claim ownership" step on the upload page that links their real TXC (LTC-clone) wallet via `verifymessage`. Show the connected wallet in the header.

## Behavior

1. **First page load** — no wallet. `useWallet()` returns `address: null`. Header shows a `connect wallet` link (goes to a small modal/route that explains the address+signature flow). No address is invented.
2. **Upload (file or by-CID)** — works without a wallet. An optional collapsible panel: *"Sign this upload and claim ownership (optional)"* with two fields:
   - TXC address (base58, validated client + server-side)
   - Signature produced by the user's external TXC wallet over a server-issued nonce/message
   When both are filled, submit them with the upload; server verifies via `verifyMessage` (already wired) and stores `owner_wallet` + `owner_proof_status='verified'`. Otherwise `owner_wallet` stays NULL and `owner_proof_status='unverified'` — video still publishes, payouts/escrow are simply unclaimable until they sign later.
3. **Header** — when a wallet is connected, show `manage [abcdef]` (chars 2–7 of the TXC address) linking to `/manage`. When not connected, show `connect wallet`. Persist the verified address + signature in `localStorage` so subsequent uploads pre-fill it.
4. **Manage page** — gains a "Claim ownership" action on each unverified video the user uploaded in this browser session (uses the same nonce → sign → verify flow already in `videos.functions.ts`).

## Technical Details

### Wallet client (`src/lib/wallet.ts`)
- Drop `randomAddress()` and the auto-`connect()` behavior entirely.
- `useWallet()` exposes `{ address, signature, setVerifiedWallet(addr, sig), disconnect() }` — no auto-creation.
- Address validation helper for TXC base58 (LTC-style: `L…`, `M…`, `3…`, plus bech32 `txc1…` if the node supports it). Reuse the same regex on the client as the server.

### Server schema
- `walletSchema` in `src/lib/videos.functions.ts` currently enforces `^0x[a-fA-F0-9]{40}$`. Replace with a TXC-address schema (base58 + optional bech32). Allow `null` where appropriate.
- `registerUpload` / `addByCid` / `getUploadUrl`: make `wallet` optional. When omitted, store `owner_wallet = null`, skip the ownership stamp, and skip escrow setup. When present **with** a signature, run the existing `verifyMessage` path inline so the upload is born verified.
- Add a `getOwnershipNonce({ purpose: 'upload' | 'claim', cid? })` server fn that returns a short-lived nonce string + the exact message to sign. For uploads we issue the nonce up-front (before the file is sent) and bind it to the eventual CID at register time.

### DB
- `videos.owner_wallet` is currently `NOT NULL`. Migration: make it nullable; add CHECK `owner_proof_status IN ('unverified','pending','verified')`. Existing rows keep their fake `0x…` values for now (no data migration needed for MVP — they'll just look weird in the manage list until re-claimed). Optional follow-up: null them out.
- `comments.commenter_wallet` already nullable — no change.

### Header (`src/components/Header.tsx`)
- Read `address` from `useWallet()`. Render either:
  - `<Link to="/manage">manage {address.slice(1,7)}</Link>` (drop the leading prefix char like `L`/`M`/`t` so it reads as a clean 6-char id), or
  - a `connect wallet` link/button that opens a small dialog explaining the sign flow (or routes to `/connect`).

### Upload page (`src/routes/upload.tsx`)
- Remove the `useEffect(() => { if (!address) connect(); }, …)` auto-connect.
- Drop `!address` from the submit guard.
- Add an `<Accordion>` / collapsible "Sign this upload and claim ownership (optional)" section with the two inputs and a "How do I sign?" helper (one-line instructions: open TXC Core → File → Sign Message → paste address + message → copy signature here).
- Pass `wallet` and `signature` (both optional) into `registerUpload` / `addByCid`.

### Manage page
- Show videos uploaded from this browser even if `owner_wallet` is null, by tracking CIDs in `localStorage` at upload time (cheap MVP — no extra table). For each unverified one, show a "Claim ownership" button that runs the existing nonce → signature flow.

## Out of Scope

- Real wallet-extension integration (no MetaMask equivalent for TXC yet).
- Migrating historical fake `0x…` rows.
- Changing the comment / boost wallet flows (they already accept null).

## Files Touched

- `src/lib/wallet.ts` — rewrite (no auto-create, store verified sig)
- `src/lib/videos.functions.ts` — relax `walletSchema`, make wallet optional in upload fns, add `getOwnershipNonce`
- `src/components/Header.tsx` — connect/manage chip
- `src/routes/upload.tsx` — optional sign panel, allow no-wallet submit
- `src/routes/manage.tsx` — surface anon uploads + per-video claim
- One migration: `videos.owner_wallet` nullable
