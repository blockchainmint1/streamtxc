CREATE TABLE public.live_push_targets (
  owner_wallet text NOT NULL,
  site text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  last_state text NOT NULL DEFAULT 'off',
  last_stream_id uuid,
  last_pushed_at timestamptz,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_wallet, site)
);
GRANT ALL ON public.live_push_targets TO service_role;
REVOKE ALL ON public.live_push_targets FROM anon, authenticated;
ALTER TABLE public.live_push_targets ENABLE ROW LEVEL SECURITY;