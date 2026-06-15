-- Drop leftover permissive SELECT policy on comments. All comment reads
-- happen server-side via supabaseAdmin; there are no Data API grants to
-- anon/authenticated on this table, so the policy was dead but flagged
-- by the scanner as it exposed sensitive payment columns (deposit_wallet,
-- derivation_index) if grants were ever added.
DROP POLICY IF EXISTS "Anyone can view comments" ON public.comments;

-- Defense in depth: explicitly revoke any privileges on sensitive tables
-- from anon/authenticated so a future stray GRANT cannot expose them.
REVOKE ALL ON public.comments FROM anon, authenticated;
REVOKE ALL ON public.view_events FROM anon, authenticated;
REVOKE ALL ON public.imports FROM anon, authenticated;

-- Ensure service_role retains full access (used by server functions).
GRANT ALL ON public.comments TO service_role;
GRANT ALL ON public.view_events TO service_role;
GRANT ALL ON public.imports TO service_role;