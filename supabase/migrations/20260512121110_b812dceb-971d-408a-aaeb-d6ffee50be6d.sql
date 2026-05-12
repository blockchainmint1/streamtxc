-- Pay-to-comment: per-comment deposit wallet + chunked on-chain body.
-- Same pattern as videos: derive a fresh wallet per comment, watcher
-- promotes 'pending_payment' → 'active' once funds arrive, then stamps
-- the comment body across N OP_RETURN chunks.

ALTER TABLE public.comments
  ADD COLUMN IF NOT EXISTS deposit_wallet text,
  ADD COLUMN IF NOT EXISTS derivation_index bigint,
  ADD COLUMN IF NOT EXISTS payment_required_txc numeric,
  ADD COLUMN IF NOT EXISTS payment_received_txc numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pending_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS paid_at timestamptz,
  ADD COLUMN IF NOT EXISTS body_hash text,
  ADD COLUMN IF NOT EXISTS chunk_tx_hashes text[];

ALTER TABLE public.comment_boosts
  ADD COLUMN IF NOT EXISTS deposit_wallet text,
  ADD COLUMN IF NOT EXISTS derivation_index bigint,
  ADD COLUMN IF NOT EXISTS payment_required_txc numeric,
  ADD COLUMN IF NOT EXISTS payment_received_txc numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pending_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS paid_at timestamptz,
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active';

CREATE INDEX IF NOT EXISTS idx_comments_pending
  ON public.comments (pending_expires_at)
  WHERE status = 'pending_payment';

CREATE INDEX IF NOT EXISTS idx_boosts_pending
  ON public.comment_boosts (pending_expires_at)
  WHERE status = 'pending_payment';

-- Allow the public to also see their own pending comment so the UI can
-- poll status. Pending rows stay visible to all; we hide them in the
-- listComments server fn instead (filtered by status='active').
DROP POLICY IF EXISTS "Anyone can view comments" ON public.comments;
CREATE POLICY "Anyone can view comments"
  ON public.comments
  FOR SELECT
  USING (hidden_at IS NULL);