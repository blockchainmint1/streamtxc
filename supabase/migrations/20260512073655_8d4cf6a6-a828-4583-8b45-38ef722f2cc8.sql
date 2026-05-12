-- Per-video deterministic wallet + lifecycle event log.
-- Each video gets its own TXC address derived from a platform xpub. Every
-- on-chain action (claim, payment, renewal, takedown, dmca) is sent to that
-- address so mempool.texitcoin.org/address/<addr> is the canonical, public
-- history of the video. Bevis-style, but for IPFS pins.

CREATE SEQUENCE IF NOT EXISTS public.video_wallet_index_seq START 1;

ALTER TABLE public.videos
  ADD COLUMN IF NOT EXISTS video_wallet text,
  ADD COLUMN IF NOT EXISTS derivation_index bigint;

CREATE UNIQUE INDEX IF NOT EXISTS videos_video_wallet_key
  ON public.videos (video_wallet)
  WHERE video_wallet IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS videos_derivation_index_key
  ON public.videos (derivation_index)
  WHERE derivation_index IS NOT NULL;

-- Lifecycle event log. One row per OP_RETURN we broadcast for a video.
-- event_type: 'C' claim | 'P' payment | 'R' renewal | 'X' takedown | 'D' dmca
CREATE TABLE IF NOT EXISTS public.chain_events (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  video_cid text NOT NULL,
  video_wallet text,
  event_type text NOT NULL,
  tx_hash text NOT NULL,
  op_return_payload text NOT NULL,
  from_wallet text,
  to_wallet text,
  block_number bigint,
  block_hash text,
  status text NOT NULL DEFAULT 'mempool',
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS chain_events_video_cid_idx
  ON public.chain_events (video_cid, created_at DESC);
CREATE INDEX IF NOT EXISTS chain_events_video_wallet_idx
  ON public.chain_events (video_wallet);
CREATE UNIQUE INDEX IF NOT EXISTS chain_events_tx_hash_key
  ON public.chain_events (tx_hash);

ALTER TABLE public.chain_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can view chain_events"
  ON public.chain_events
  FOR SELECT
  USING (true);
