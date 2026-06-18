DROP POLICY IF EXISTS "Anyone can view chain_events" ON public.chain_events;
DROP POLICY IF EXISTS "Anyone can view payments" ON public.payments;
DROP POLICY IF EXISTS "Anyone can view creator_credits" ON public.creator_credits;
REVOKE SELECT ON public.chain_events FROM anon, authenticated;
REVOKE SELECT ON public.payments FROM anon, authenticated;
REVOKE SELECT ON public.creator_credits FROM anon, authenticated;