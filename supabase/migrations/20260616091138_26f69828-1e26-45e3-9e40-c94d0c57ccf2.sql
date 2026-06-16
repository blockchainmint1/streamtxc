
CREATE TABLE public.wallet_notification_prefs (
  wallet TEXT PRIMARY KEY,
  email TEXT,
  email_verify_token TEXT,
  email_verify_expires_at TIMESTAMPTZ,
  email_verified_at TIMESTAMPTZ,
  telegram_chat_id BIGINT,
  telegram_username TEXT,
  telegram_pairing_code TEXT,
  telegram_pairing_expires_at TIMESTAMPTZ,
  notify_expiry BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT ALL ON public.wallet_notification_prefs TO service_role;
ALTER TABLE public.wallet_notification_prefs ENABLE ROW LEVEL SECURITY;
-- No policies: only service_role (server functions) may read/write.

CREATE UNIQUE INDEX wallet_notification_prefs_email_verify_token_idx
  ON public.wallet_notification_prefs (email_verify_token)
  WHERE email_verify_token IS NOT NULL;

CREATE UNIQUE INDEX wallet_notification_prefs_telegram_pairing_code_idx
  ON public.wallet_notification_prefs (telegram_pairing_code)
  WHERE telegram_pairing_code IS NOT NULL;

CREATE UNIQUE INDEX wallet_notification_prefs_telegram_chat_id_idx
  ON public.wallet_notification_prefs (telegram_chat_id)
  WHERE telegram_chat_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.tg_wallet_notification_prefs_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

CREATE TRIGGER wallet_notification_prefs_updated_at
  BEFORE UPDATE ON public.wallet_notification_prefs
  FOR EACH ROW EXECUTE FUNCTION public.tg_wallet_notification_prefs_updated_at();

ALTER TABLE public.videos
  ADD COLUMN IF NOT EXISTS expiring_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS unpin_after TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS notified_pre_expiry_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS notified_expiring_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS notified_unpinned_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS videos_unpin_after_idx
  ON public.videos (unpin_after)
  WHERE unpin_after IS NOT NULL;
