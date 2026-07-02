-- Replace overly-permissive public SELECT policy with role-scoped policy.
-- Column-level GRANTs already exclude the wallet column from anon/authenticated,
-- so raw wallet addresses cannot be read via Data API or Realtime.
DROP POLICY IF EXISTS "Anyone can view live chat" ON public.live_chat_messages;

CREATE POLICY "Chat messages readable (wallet column excluded via grants)"
  ON public.live_chat_messages
  FOR SELECT
  TO anon, authenticated
  USING (true);