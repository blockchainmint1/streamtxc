# Notifications + expiring lifecycle

Two related pieces:
1. Let a wallet register Telegram and/or email so we can warn them before their videos die.
2. Add a real "expiring → unpinned → archived" lifecycle so a wipe isn't instant and metadata is never lost.

---

## 1. Wallet notification prefs

New table `wallet_notification_prefs` keyed by `wallet` (no users table — wallet signature is identity):

| column | notes |
|---|---|
| `wallet` (pk) | the owner_wallet string |
| `email` | nullable, plain text |
| `email_verified_at` | set after click-through verification |
| `telegram_chat_id` | nullable, set after they DM the bot with their pairing code |
| `telegram_username` | display only |
| `pairing_code` | short random token they paste into our Telegram bot to link the chat to their wallet |
| `pairing_expires_at` | 15-min TTL |
| `notify_expiry` | bool, default true |
| `created_at` / `updated_at` | |

RLS: locked. All reads/writes via server functions gated by `requireWalletSignature` (same pattern used elsewhere for wallet-owned rows).

UI lives in `src/routes/manage.tsx` as a new "Notifications" card above the videos list:
- Email field with "Send verification" button → emails a magic verify link (`/api/public/notify/verify-email?token=…`).
- Telegram block: shows "Connect Telegram", reveals pairing code + a `https://t.me/<bot>?start=<code>` deep link. Once the bot sees `/start <code>` it stores chat_id and the UI auto-refreshes.
- Toggle per alert type (only "expiry" for now).

## 2. Expiring lifecycle for videos

Today: grace expired → immediate `unpinByCid` + `status=unpinned`. We replace that with a softer 3-state machine on existing `videos` rows (no row deletion ever):

```text
active ──expires_at passed──▶ expiring (1-week pin grace)
                                  │
                                  ├─owner pays──▶ active
                                  │
                                  └─grace passed──▶ unpinned (Pinata removed,
                                                              row + metadata kept forever)
```

New columns on `videos`:
- `expiring_at timestamptz` — when we entered expiring (= original expires_at).
- `unpin_after timestamptz` — `expiring_at + 7 days`; cron only unpins past this.
- `notified_pre_expiry_at` / `notified_expiring_at` / `notified_unpinned_at` — dedupe alert sends.

Status enum gains `expiring`. `unpinned` rows keep all metadata (title, thumbnail_cid, chain events, comments) so a renewal payment re-pins and restores.

### Payment watcher changes (`src/routes/api/public/hooks/payment-watcher.ts`)
- When `expires_at` passes for a paid video: set `status='expiring'`, `expiring_at=now`, `unpin_after=now+7d`. Don't unpin.
- Only call `unpinByCid` once `now > unpin_after`.
- Restore flow already clears `unpinned_at` and bumps `expires_at`; extend it to also clear `expiring_at` / `unpin_after`.

### Pre-expiry alerts
Same cron pass enqueues notifications:
- 7 days before `expires_at` → "your video expires in 7 days" (sets `notified_pre_expiry_at`).
- On entry to `expiring` → "video is in 7-day grace, pay to keep it" (sets `notified_expiring_at`).
- On actual unpin → "video unpinned; metadata kept, repay anytime to restore" (sets `notified_unpinned_at`).

Each alert lookups `wallet_notification_prefs` for the row's `owner_wallet` and fans out to whichever channels are configured & verified.

## 3. Delivery

### Telegram
Use the Telegram connector (gateway). New public route `src/routes/api/public/hooks/telegram.ts` receives bot webhooks, handles `/start <code>` to bind chat_id ↔ wallet. Outbound sends use `sendMessage` via the gateway. Bot token / connector linking is handled via `standard_connectors--connect telegram` — I'll prompt for that when wiring up.

### Email
Use Lovable Emails (built-in). Requires `email_domain--setup_email_infra` + `scaffold_transactional_email`. Templates:
- `wallet-verify-email` (verification link)
- `video-expiry-warning` (7-day heads-up)
- `video-expiring` (entered grace)
- `video-unpinned` (post-unpin notice with restore link)

If you don't already have an email domain configured I'll trigger the setup dialog first.

## 4. Migrations (one file)

1. `CREATE TABLE public.wallet_notification_prefs` + GRANTs + RLS (deny-all; server-side only).
2. `ALTER TABLE public.videos ADD COLUMN expiring_at, unpin_after, notified_*`.
3. Backfill: for rows currently `status='unpinned'`, leave alone. For active rows, no change.

## 5. Out of scope (will do later when you ask)
- SMS / push.
- Per-video opt-out.
- Notifications dashboard / history.
- Other alert types (comment paid, view milestones, etc.) — table is already shaped for them.

---

## Open questions before I build

1. **Telegram bot**: do you already have a bot (BotFather token) you want to use, or should I have you connect one via the Telegram connector?
2. **Email domain**: is one configured on this project, or should I kick off email-domain setup first?
3. **Grace length**: you said 1 week — confirm 7 days exactly (vs. 7 calendar days from local midnight, etc.)?
4. **"Hold metadata forever"** — I'll keep unpinned rows indefinitely. OK to also keep `thumbnail_cid` pinned so the manage page still shows a poster after unpin?
