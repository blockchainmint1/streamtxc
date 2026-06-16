DROP POLICY IF EXISTS "Anyone can view comment boosts" ON public.comment_boosts;
REVOKE SELECT ON public.comment_boosts FROM anon, authenticated;