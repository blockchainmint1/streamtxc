CREATE TABLE public.meeting_rooms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_wallet text NOT NULL UNIQUE,
  title text NOT NULL DEFAULT 'Daily team meeting',
  join_code text NOT NULL UNIQUE,
  view_code text NOT NULL UNIQUE,
  chime_meeting_id text,
  chime_meeting jsonb,
  meeting_generation integer NOT NULL DEFAULT 0,
  broadcast_pipeline_id text,
  broadcast_started_at timestamptz,
  last_joined_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT meeting_rooms_codes_differ CHECK (join_code <> view_code)
);
GRANT ALL ON public.meeting_rooms TO service_role;
ALTER TABLE public.meeting_rooms ENABLE ROW LEVEL SECURITY;