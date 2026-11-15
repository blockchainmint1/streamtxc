CREATE TABLE public.meeting_seats (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id uuid NOT NULL REFERENCES public.meeting_rooms(id) ON DELETE CASCADE,
  meeting_id text NOT NULL,
  attendee_id text NOT NULL UNIQUE,
  role text NOT NULL CHECK (role IN ('host','participant','viewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz,
  left_at timestamptz
);
GRANT ALL ON public.meeting_seats TO service_role;
ALTER TABLE public.meeting_seats ENABLE ROW LEVEL SECURITY;
CREATE INDEX meeting_seats_meeting_idx ON public.meeting_seats(meeting_id) WHERE left_at IS NULL;

ALTER TABLE public.meeting_rooms
  ADD COLUMN max_seats integer NOT NULL DEFAULT 25 CHECK (max_seats BETWEEN 2 AND 250),
  ADD COLUMN team_can_start boolean NOT NULL DEFAULT false;

-- Bobby's own (free) rooms keep today's behaviour: the team can open them without him.
UPDATE public.meeting_rooms SET team_can_start = true WHERE owner_wallet = 'TmmoqqhcfBZWRG8feCTE2c4N4BsADgwD1m';

ALTER TABLE public.meeting_recordings
  ADD COLUMN publish_title text,
  ADD COLUMN publish_description text;

-- Failed chain stamps store no transaction id instead of a look-alike placeholder.
ALTER TABLE public.chain_events ALTER COLUMN tx_hash DROP NOT NULL;