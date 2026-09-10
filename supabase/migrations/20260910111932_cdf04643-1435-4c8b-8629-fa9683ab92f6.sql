DO $$ BEGIN
  CREATE TYPE public.wallet_challenge_status AS ENUM ('pending', 'signed', 'consumed', 'expired');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.wallet_login_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nonce text NOT NULL UNIQUE,
  wallet_address text,
  signature text,
  status public.wallet_challenge_status NOT NULL DEFAULT 'pending',
  one_time_token text,
  ip_address text,
  user_agent text,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '5 minutes'),
  created_at timestamptz NOT NULL DEFAULT now(),
  signed_at timestamptz,
  consumed_at timestamptz
);

CREATE INDEX IF NOT EXISTS wallet_login_challenges_token_idx ON public.wallet_login_challenges(one_time_token) WHERE one_time_token IS NOT NULL;
CREATE INDEX IF NOT EXISTS wallet_login_challenges_expires_idx ON public.wallet_login_challenges(expires_at);

GRANT ALL ON public.wallet_login_challenges TO service_role;

ALTER TABLE public.wallet_login_challenges ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Deny all client access to wallet challenges" ON public.wallet_login_challenges;
CREATE POLICY "Deny all client access to wallet challenges"
ON public.wallet_login_challenges
FOR ALL
TO anon, authenticated
USING (false)
WITH CHECK (false);

CREATE OR REPLACE FUNCTION public.purge_expired_wallet_challenges()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  DELETE FROM public.wallet_login_challenges
  WHERE expires_at < now() - interval '1 hour';
$$;