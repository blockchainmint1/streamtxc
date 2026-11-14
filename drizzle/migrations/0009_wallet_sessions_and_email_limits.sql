CREATE TABLE public.wallet_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  user_agent text
);
CREATE INDEX wallet_sessions_wallet_idx ON public.wallet_sessions(wallet, revoked_at);
GRANT ALL ON public.wallet_sessions TO service_role;
ALTER TABLE public.wallet_sessions ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE public.wallet_sessions IS 'Server-side record of every sign-in so a session can be cancelled early. Server-only.';

ALTER TABLE public.wallet_notification_prefs
  ADD COLUMN IF NOT EXISTS email_verify_last_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS email_verify_window_start timestamptz,
  ADD COLUMN IF NOT EXISTS email_verify_send_count integer NOT NULL DEFAULT 0;