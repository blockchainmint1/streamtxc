
-- Comments table
CREATE TABLE public.comments (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  video_cid TEXT NOT NULL,
  body TEXT NOT NULL,
  commenter_wallet TEXT,
  initial_payment_txc NUMERIC NOT NULL,
  boost_total_txc NUMERIC NOT NULL DEFAULT 0,
  creator_share_txc NUMERIC NOT NULL DEFAULT 0,
  hosting_share_txc NUMERIC NOT NULL DEFAULT 0,
  platform_share_txc NUMERIC NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  hidden_at TIMESTAMP WITH TIME ZONE,
  hidden_reason TEXT,
  tx_hash TEXT,
  op_return_payload TEXT,
  mock_tx_hash TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  last_boost_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);
CREATE INDEX idx_comments_video_cid ON public.comments(video_cid);
CREATE INDEX idx_comments_video_score ON public.comments(video_cid, last_boost_at DESC);
ALTER TABLE public.comments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can view comments"
  ON public.comments FOR SELECT
  USING (status = 'active' AND hidden_at IS NULL);

-- Comment boosts table
CREATE TABLE public.comment_boosts (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  comment_id UUID NOT NULL REFERENCES public.comments(id) ON DELETE CASCADE,
  booster_wallet TEXT,
  amount_txc NUMERIC NOT NULL,
  tx_hash TEXT,
  op_return_payload TEXT,
  mock_tx_hash TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);
CREATE INDEX idx_comment_boosts_comment ON public.comment_boosts(comment_id);
ALTER TABLE public.comment_boosts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can view comment boosts"
  ON public.comment_boosts FOR SELECT
  USING (true);

-- Hosting credit accrual on videos
ALTER TABLE public.videos
  ADD COLUMN IF NOT EXISTS hosting_credit_txc NUMERIC NOT NULL DEFAULT 0;
