CREATE TABLE public.chain_record_repairs (
 source_event_id uuid PRIMARY KEY REFERENCES public.chain_events(id),
 replacement_event_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
 state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','preparing','prepared','complete')),
 record_cid text,
 record_json jsonb,
 payload text,
 signed_tx_hex text,
 tx_hash text,
 fee_txc numeric,
 created_at timestamptz NOT NULL DEFAULT now(),
 completed_at timestamptz
);
GRANT ALL ON public.chain_record_repairs TO service_role;
REVOKE ALL ON public.chain_record_repairs FROM anon, authenticated;
ALTER TABLE public.chain_record_repairs ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE public.chain_record_repairs IS 'Private historical repair journal. Persist signed bytes before broadcast; retry identical bytes only. Never replay payments or change ownership.';