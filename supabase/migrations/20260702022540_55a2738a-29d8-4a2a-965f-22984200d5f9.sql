-- Livestream status enum
CREATE TYPE public.live_stream_status AS ENUM (
  'scheduled', 'starting', 'live', 'ending', 'ended', 'archived'
);

CREATE TABLE public.live_streams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  description text,
  thumbnail_cid text,
  status public.live_stream_status NOT NULL DEFAULT 'scheduled',
  scheduled_for timestamptz,
  started_at timestamptz,
  ended_at timestamptz,
  owner_wallet text NOT NULL,
  medialive_channel_id text,
  hls_url text,
  archive_video_cid text,
  archive_transcode_job_id text,
  simulcast_youtube_url text,
  simulcast_twitter_url text,
  simulcast_facebook_url text,
  peak_viewers integer NOT NULL DEFAULT 0,
  total_views integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX live_streams_status_idx ON public.live_streams (status);
CREATE INDEX live_streams_scheduled_for_idx ON public.live_streams (scheduled_for);
CREATE INDEX live_streams_owner_wallet_idx ON public.live_streams (owner_wallet);

-- Public read (anon + authenticated). No client writes; server does it via service_role.
GRANT SELECT ON public.live_streams TO anon;
GRANT SELECT ON public.live_streams TO authenticated;
GRANT ALL    ON public.live_streams TO service_role;

ALTER TABLE public.live_streams ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can view live streams"
  ON public.live_streams FOR SELECT
  USING (true);

-- updated_at trigger (reuse existing helper pattern)
CREATE OR REPLACE FUNCTION public.tg_live_streams_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

CREATE TRIGGER live_streams_updated_at
  BEFORE UPDATE ON public.live_streams
  FOR EACH ROW EXECUTE FUNCTION public.tg_live_streams_updated_at();

-- Realtime so the LIVE badge / banner / /live page update instantly
ALTER PUBLICATION supabase_realtime ADD TABLE public.live_streams;

-- Extend videos table so an auto-archived stream links back to its live_stream row
ALTER TABLE public.videos
  ADD COLUMN IF NOT EXISTS live_stream_id uuid REFERENCES public.live_streams(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS source_kind text;

CREATE INDEX IF NOT EXISTS videos_live_stream_id_idx ON public.videos (live_stream_id);