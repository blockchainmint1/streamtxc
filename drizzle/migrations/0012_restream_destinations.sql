CREATE TABLE public.restream_destinations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_wallet text NOT NULL,
  name text NOT NULL,
  platform text NOT NULL DEFAULT 'custom',
  server_url text NOT NULL,
  stream_key_enc text NOT NULL,
  key_hint text NOT NULL DEFAULT '',
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX restream_destinations_owner_idx ON public.restream_destinations(owner_wallet);
REVOKE ALL ON public.restream_destinations FROM anon, authenticated;
GRANT ALL ON public.restream_destinations TO service_role;
ALTER TABLE public.restream_destinations ENABLE ROW LEVEL SECURITY;