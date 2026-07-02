
CREATE TABLE public.live_chat_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stream_id uuid NOT NULL REFERENCES public.live_streams(id) ON DELETE CASCADE,
  wallet text,
  display_name text,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX live_chat_messages_stream_idx ON public.live_chat_messages (stream_id, created_at);

GRANT SELECT ON public.live_chat_messages TO anon;
GRANT SELECT ON public.live_chat_messages TO authenticated;
GRANT ALL ON public.live_chat_messages TO service_role;

ALTER TABLE public.live_chat_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can view live chat"
  ON public.live_chat_messages FOR SELECT
  USING (true);

ALTER PUBLICATION supabase_realtime ADD TABLE public.live_chat_messages;
