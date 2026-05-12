ALTER TABLE public.videos
  ADD COLUMN IF NOT EXISTS payment_required_txc numeric,
  ADD COLUMN IF NOT EXISTS payment_received_txc numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS paid_at timestamptz,
  ADD COLUMN IF NOT EXISTS payment_tx_hash text,
  ADD COLUMN IF NOT EXISTS unpinned_at timestamptz;

CREATE INDEX IF NOT EXISTS videos_payment_pending_idx
  ON public.videos (created_at)
  WHERE paid_at IS NULL AND unpinned_at IS NULL;