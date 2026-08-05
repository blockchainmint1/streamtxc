REVOKE ALL ON public.live_chat_messages FROM anon, authenticated;

GRANT SELECT (id, stream_id, display_name, body, created_at)
  ON public.live_chat_messages TO anon, authenticated;

GRANT ALL ON public.live_chat_messages TO service_role;

DROP POLICY IF EXISTS "Chat messages readable (wallet column excluded via grants)" ON public.live_chat_messages;

CREATE POLICY "Chat messages readable, wallet column not granted"
  ON public.live_chat_messages
  FOR SELECT
  TO anon, authenticated
  USING (true);