DROP POLICY IF EXISTS "Anyone can view comments" ON public.comments;
REVOKE ALL ON public.comments FROM anon, authenticated;
GRANT ALL ON public.comments TO service_role;
ALTER TABLE public.comments ENABLE ROW LEVEL SECURITY;