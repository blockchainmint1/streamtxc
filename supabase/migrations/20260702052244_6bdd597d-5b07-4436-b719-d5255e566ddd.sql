
-- Phase C: TXC/minute prepaid live billing.

CREATE TABLE public.live_credit_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet text NOT NULL,
  delta_txc numeric(20,8) NOT NULL,
  kind text NOT NULL, -- deposit | consumption | refund | manual
  stream_id uuid REFERENCES public.live_streams(id) ON DELETE SET NULL,
  txid text,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX live_credit_ledger_wallet_idx ON public.live_credit_ledger(wallet, created_at DESC);
CREATE INDEX live_credit_ledger_stream_idx ON public.live_credit_ledger(stream_id) WHERE stream_id IS NOT NULL;

GRANT SELECT ON public.live_credit_ledger TO authenticated;
GRANT ALL ON public.live_credit_ledger TO service_role;
ALTER TABLE public.live_credit_ledger ENABLE ROW LEVEL SECURITY;
-- No policies: only server code (service_role) reads/writes. Balance is
-- exposed via a server function that gates on requireWalletSession.

ALTER TABLE public.wallet_notification_prefs
  ADD COLUMN IF NOT EXISTS live_deposit_address text,
  ADD COLUMN IF NOT EXISTS live_deposit_derivation_index bigint,
  ADD COLUMN IF NOT EXISTS live_deposit_received_txc numeric(20,8) NOT NULL DEFAULT 0;
