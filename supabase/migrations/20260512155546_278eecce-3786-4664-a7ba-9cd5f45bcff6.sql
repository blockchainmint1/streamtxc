
ALTER TABLE public.videos
  ADD COLUMN IF NOT EXISTS owner_proof_status text NOT NULL DEFAULT 'unverified',
  ADD COLUMN IF NOT EXISTS owner_nonce text,
  ADD COLUMN IF NOT EXISTS owner_signature text,
  ADD COLUMN IF NOT EXISTS owner_verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS ownership_tx_hash text,
  ADD COLUMN IF NOT EXISTS escrowed_creator_txc numeric NOT NULL DEFAULT 0;

ALTER TABLE public.comments
  ADD COLUMN IF NOT EXISTS payout_status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS creator_payout_tx_hash text,
  ADD COLUMN IF NOT EXISTS hosting_payout_tx_hash text,
  ADD COLUMN IF NOT EXISTS platform_payout_tx_hash text,
  ADD COLUMN IF NOT EXISTS payout_attempted_at timestamptz;
