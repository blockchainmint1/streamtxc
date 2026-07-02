# Multi-user Livestreaming

Three parts, built in this order.

## 1. Admin-gated eligibility (ship first, unblocks the rest)

New column on `wallet_notification_prefs` (already keyed by wallet — the natural home for per-wallet flags):

- `live_eligible boolean not null default false`
- `live_rate_txc_per_minute numeric(20,8)` — optional per-wallet override; falls back to a global default
- `live_max_concurrent_minutes int default 240` — safety cap so a stuck channel can't drain a wallet overnight

Admin surface in `/manage` → "Live eligibility" table:
- Wallet search, toggle `live_eligible`, edit rate override.
- Uses `requireWalletSession` + admin-wallet check (same pattern as `bug_reports_admin` fix).

A signed-in user with `live_eligible = true` sees a new **"Go Live"** section on `/manage`; everyone else sees nothing. No public UI copy about it.

## 2. Per-user MediaLive channels (on-demand provisioning)

Yes, this is doable via the MediaLive API — we already talk to it with `aws4fetch`. The moving parts:

**On first "Enable live" click for a wallet** (server fn `provisionLiveChannel`):
1. Create an Input (RTMP_PUSH, 1 destination for solo streamers) via `POST /prod/inputs`. Attach the existing input security group (`MEDIALIVE_INPUT_SECURITY_GROUP_ID`).
2. Create a MediaPackage channel via `POST /channels` on `mediapackage.<region>.amazonaws.com` — one per user so their HLS endpoint is isolated.
3. Create the MediaLive Channel via `POST /prod/channels` using our existing CloudFormation encoder settings as a JSON template (extracted from `04-medialive.yaml` into `src/lib/medialive-encoder-template.ts`), pointed at the user's MediaPackage channel + the archive S3 bucket under prefix `per-user/<wallet>/`.
4. Persist the identifiers in a new `live_channels` table (see schema below). Do NOT start the channel yet — provisioning is free; running is not.

**On "Go Live"**: `startChannel(channelId)` for that user's row, flip status, store started_at.
**On "Stop"**: `stopChannel(channelId)`, close the billing window.

**Concurrency cap**: MediaLive has an account-level channel limit (default 5). We'll expose one config `LIVE_MAX_CHANNELS_RUNNING` (soft limit checked before Start) and surface a clear "channel cap reached, try again later" error. Users can request a raise from AWS if we grow.

**Cleanup job**: `pg_cron` every hour → for any `live_channels` row unused for 30 days, delete the MediaLive channel + input + MediaPackage channel via API. Provisioned-idle isn't free (input has hourly cost), so this matters.

### New tables

```sql
create table public.live_channels (
  id uuid primary key default gen_random_uuid(),
  owner_wallet text not null unique,
  medialive_channel_id text not null,
  medialive_input_id text not null,
  mediapackage_channel_id text not null,
  rtmp_url text not null,
  stream_key text not null,
  hls_url text not null,
  archive_prefix text not null,
  status text not null default 'idle',  -- idle | starting | running | stopping | error
  provisioned_at timestamptz not null default now(),
  last_used_at timestamptz
);
```

The existing `live_streams` table stays as-is (per-broadcast metadata + chat) but adds `channel_row_id uuid references live_channels(id)` so a stream row is tied to the user's channel.

## 3. TXC/minute prepaid billing

Model: a wallet must hold a **positive "live credit" balance** in TXC before Start. Credit is consumed per minute the channel is `RUNNING`.

**New tables:**

```sql
create table public.live_credit_ledger (
  id uuid primary key default gen_random_uuid(),
  wallet text not null,
  delta_txc numeric(20,8) not null,       -- + on deposit, - on consumption
  kind text not null,                     -- deposit | consumption | refund
  stream_id uuid references live_streams(id),
  txid text,                              -- on-chain payment txid for deposits
  created_at timestamptz not null default now()
);
create index on public.live_credit_ledger(wallet, created_at desc);
```

Balance = `sum(delta_txc)` per wallet. A cached `live_credit_balance` view or a materialized column can come later; SUM over a wallet's rows is fine for now.

**Deposit flow**: existing `payments` + `chain_events` pipeline already watches the hosting address. Add a new `payment_kind = 'live-credit'` variant so a user can send TXC with an OP_RETURN memo `LIVECREDIT:<wallet>` (or a dedicated derived address per wallet — cleaner). On confirmation, insert a positive ledger row.

  Simpler v1: reuse the wallet's existing derivation with a `live:` prefix on the memo. The payment-watcher already handles memo routing.

**Consumption**: a `pg_cron` job every minute:

```sql
-- For each running channel, deduct (rate_txc_per_min * 1 minute)
insert into live_credit_ledger (wallet, delta_txc, kind, stream_id)
select owner_wallet, -rate, 'consumption', current_stream_id
from live_channels_running_view;
```

When a wallet's balance falls below `rate_txc_per_min`, the same job calls `stopChannel(...)` and sets `live_streams.stopped_reason = 'out_of_credits'`.

**Preflight**: `startLiveStream` refuses to call `startChannel` unless balance covers at least 5 minutes.

**Rate**: default `LIVE_DEFAULT_RATE_TXC_PER_MIN` (a secret, easy to tune). Rough target: cover ~$2.50/hr AWS + margin at current TXC price. We'll bake in a `getTxcUsdPrice()`-derived recommendation shown in the UI but charge a fixed TXC rate to keep bookkeeping simple.

## UI surface

`/manage` gains a **Live** section (only for `live_eligible` wallets):

- Balance pill: `X TXC (~N minutes at current rate)`
- **[Add credit]** → shows the pay-to address + memo, QR, waits for confirmation
- **[Enable live]** (first time only) → provisions channel, then shows RTMP creds
- **[Go Live]** / **[Stop]** — same channel-state polling + signal-health probe we built for admin, but scoped to the user's row
- List of past streams with **[Archive to library]** / **[Skip]** (already built, just needs to respect ownership)

Chat and `/live` public page: keep as-is, but `getActiveLiveStream` becomes plural — `listActiveLiveStreams` — and `/live` lists all currently running streams with thumbnails. `/live/$streamId` for individual playback (new route).

## Technical details

**Files touched:**
- `src/lib/aws-medialive.server.ts` — add `createInput`, `createChannel`, `deleteChannel`, `deleteInput`; add MediaPackage client (`createMediaPackageChannel`, `deleteMediaPackageChannel`).
- `src/lib/medialive-encoder-template.ts` (new) — the JSON `EncoderSettings` block, extracted from the CFN template.
- `src/lib/live-channels.functions.ts` (new) — `provisionLiveChannel`, `startMyStream`, `stopMyStream`, `getMyLiveBalance`, `listMyLiveStreams`, `getMyRtmpConfig`. All gated by `requireWalletSession` + `live_eligible` check.
- `src/lib/livestream.functions.ts` — refactor admin fns to be wallet-aware (owner scoping); keep admin overrides.
- `src/routes/manage.tsx` — new "Live" section for eligible wallets; new "Live eligibility" admin panel.
- `src/routes/live.tsx` — list active streams; add `src/routes/live.$streamId.tsx` for individual playback.
- `src/routes/api/public/hooks/live-billing-tick.ts` (new) — pg_cron target, `x-admin-token` gated like `finalize-stuck-hls`.
- `src/routes/api/public/hooks/live-channel-gc.ts` (new) — hourly cleanup of idle channels.
- `src/lib/payment-watcher.ts` (existing hook) — route `live:` memo payments to `live_credit_ledger`.

**Migration:** four tables (`live_channels`, `live_credit_ledger`, columns on `wallet_notification_prefs`, index), plus `pg_cron` jobs `live-billing-tick` (every 1 min) and `live-channel-gc` (every 1 hour).

**Secrets needed:**
- `LIVE_DEFAULT_RATE_TXC_PER_MIN` — set via `add_secret`
- `LIVE_MAX_CHANNELS_RUNNING` — set via `add_secret`
- `MEDIALIVE_INPUT_SECURITY_GROUP_ID` — existing input's SG (from `describeInput`); set via `add_secret`
- Existing `AWS_*`, `MEDIALIVE_REGION`, `LIVE_ARCHIVE_BUCKET` reused

**Risks / callouts:**
- MediaLive account channel limit (5 default) will bite in production; we'll need an AWS support ticket to raise it before opening the floodgates.
- Provisioned-but-idle channels still cost pennies/hr for the input. GC job matters.
- MediaPackage HLS endpoints per user means the current single `LIVE_HLS_URL` env goes away — `live_channels.hls_url` becomes authoritative.

## Sequencing

Phase A (this turn): eligibility flag, admin toggle UI, no channel changes yet.
Phase B: channel provisioning + start/stop scoped to owner_wallet, no billing (free during testing).
Phase C: credit ledger, deposit routing, billing tick, preflight balance check.
Phase D: `/live` listing multiple streams, per-stream playback route.

Approve and I'll ship Phase A now; B/C/D roll out in follow-up turns so each is reviewable.