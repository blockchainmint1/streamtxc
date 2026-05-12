
-- Videos: keyed by IPFS CID
CREATE TABLE public.videos (
  cid TEXT PRIMARY KEY,
  owner_wallet TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  size_bytes BIGINT NOT NULL,
  duration_s INTEGER,
  mime_type TEXT,
  status TEXT NOT NULL DEFAULT 'transcoding',
  mock_tx_hash TEXT,
  mock_block_number BIGINT,
  view_count BIGINT NOT NULL DEFAULT 0,
  months_prepaid INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '1 month')
);

CREATE INDEX idx_videos_owner ON public.videos(owner_wallet);
CREATE INDEX idx_videos_status ON public.videos(status);
CREATE INDEX idx_videos_created ON public.videos(created_at DESC);

-- Payments
CREATE TABLE public.payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  video_cid TEXT NOT NULL REFERENCES public.videos(cid) ON DELETE CASCADE,
  wallet TEXT NOT NULL,
  txc_amount NUMERIC(20, 6) NOT NULL,
  months_prepaid INTEGER NOT NULL,
  mock_tx_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_payments_cid ON public.payments(video_cid);
CREATE INDEX idx_payments_wallet ON public.payments(wallet);

-- View events (lightweight, debounced server-side)
CREATE TABLE public.view_events (
  id BIGSERIAL PRIMARY KEY,
  video_cid TEXT NOT NULL REFERENCES public.videos(cid) ON DELETE CASCADE,
  ip_hash TEXT NOT NULL,
  ts TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_view_events_cid_ts ON public.view_events(video_cid, ts DESC);
-- Used by the gateway debounce check (per IP+CID within a window)
CREATE INDEX idx_view_events_dedup ON public.view_events(video_cid, ip_hash, ts DESC);

-- Creator credits (off-chain reward ledger)
CREATE TABLE public.creator_credits (
  wallet TEXT PRIMARY KEY,
  credits NUMERIC(20, 6) NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Enable RLS on all tables
ALTER TABLE public.videos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.view_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.creator_credits ENABLE ROW LEVEL SECURITY;

-- Public read policies (everything on this platform is public)
CREATE POLICY "Anyone can view videos"
  ON public.videos FOR SELECT
  USING (true);

CREATE POLICY "Anyone can view payments"
  ON public.payments FOR SELECT
  USING (true);

CREATE POLICY "Anyone can view view_events"
  ON public.view_events FOR SELECT
  USING (true);

CREATE POLICY "Anyone can view creator_credits"
  ON public.creator_credits FOR SELECT
  USING (true);

-- No public write policies — all writes go through server functions using the service role key.

-- Storage bucket for the temporary upload buffer (file lands here, then gets pushed to Pinata)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'video-uploads',
  'video-uploads',
  false,
  104857600, -- 100 MB cap for MVP
  ARRAY['video/mp4', 'video/webm', 'video/quicktime']
);

-- Anyone can upload to the buffer (writes are gated by server-issued upload tokens in app logic).
CREATE POLICY "Public can upload videos to buffer"
  ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'video-uploads');

CREATE POLICY "Public can read own buffered uploads"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'video-uploads');
