CREATE TABLE public.hm_sso_links (
  member_id text PRIMARY KEY,
  wallet text NOT NULL,
  email text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);
CREATE TABLE public.hm_sso_nonces (
  nonce text PRIMARY KEY,
  expires_at timestamptz NOT NULL
);
GRANT ALL ON public.hm_sso_links TO service_role;
GRANT ALL ON public.hm_sso_nonces TO service_role;
ALTER TABLE public.hm_sso_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hm_sso_nonces ENABLE ROW LEVEL SECURITY;