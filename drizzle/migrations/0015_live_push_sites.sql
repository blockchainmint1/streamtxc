CREATE TABLE public.live_push_sites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_wallet text NOT NULL,
  name text NOT NULL,
  endpoint text NOT NULL,
  secret_sealed text NOT NULL,
  key_hint text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  last_state text NOT NULL DEFAULT 'off',
  last_stream_id uuid,
  last_pushed_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX live_push_sites_owner_idx ON public.live_push_sites (owner_wallet);
GRANT ALL ON public.live_push_sites TO service_role;
REVOKE ALL ON public.live_push_sites FROM anon, authenticated;
ALTER TABLE public.live_push_sites ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE public.live_push_targets IS 'DEPRECATED: replaced by live_push_sites';