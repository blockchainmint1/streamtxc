
CREATE TABLE public.live_channels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_wallet text NOT NULL UNIQUE,
  medialive_channel_id text NOT NULL,
  medialive_input_id text NOT NULL,
  mediapackage_channel_id text NOT NULL,
  mediapackage_endpoint_id text,
  rtmp_url text NOT NULL,
  stream_key text NOT NULL,
  hls_url text NOT NULL,
  archive_prefix text NOT NULL,
  status text NOT NULL DEFAULT 'idle',
  provisioned_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT ALL ON public.live_channels TO service_role;
-- No authenticated/anon grants: writes flow through server fns using supabaseAdmin.

ALTER TABLE public.live_channels ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.tg_live_channels_updated_at()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

CREATE TRIGGER live_channels_updated_at
BEFORE UPDATE ON public.live_channels
FOR EACH ROW EXECUTE FUNCTION public.tg_live_channels_updated_at();

ALTER TABLE public.live_streams
  ADD COLUMN IF NOT EXISTS channel_row_id uuid REFERENCES public.live_channels(id);
