
ALTER TABLE public.wallet_notification_prefs
  ADD COLUMN IF NOT EXISTS live_eligible boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS live_rate_txc_per_minute numeric(20,8),
  ADD COLUMN IF NOT EXISTS live_max_concurrent_minutes integer NOT NULL DEFAULT 240;
