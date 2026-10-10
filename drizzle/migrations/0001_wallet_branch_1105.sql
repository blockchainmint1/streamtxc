CREATE TABLE public.wallet_branch_links (
  wallet text PRIMARY KEY,
  identity_address text NOT NULL,
  xpub text NOT NULL,
  xpub_path text NOT NULL,
  next_index integer NOT NULL DEFAULT 0,
  linked_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.wallet_branch_links TO service_role;
ALTER TABLE public.wallet_branch_links ENABLE ROW LEVEL SECURITY;
CREATE POLICY "No client access to branch links" ON public.wallet_branch_links FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

CREATE TABLE public.wallet_branch_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token text NOT NULL UNIQUE,
  challenge text NOT NULL,
  wallet text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  error text,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.wallet_branch_requests TO service_role;
ALTER TABLE public.wallet_branch_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY "No client access to branch requests" ON public.wallet_branch_requests FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

ALTER TABLE public.videos ADD COLUMN owner_branch_address text, ADD COLUMN owner_branch_index integer;

CREATE OR REPLACE FUNCTION public.claim_branch_index(_wallet text)
RETURNS integer LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE public.wallet_branch_links SET next_index = next_index + 1
  WHERE wallet = _wallet RETURNING next_index - 1;
$$;
REVOKE EXECUTE ON FUNCTION public.claim_branch_index(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_branch_index(text) TO service_role;