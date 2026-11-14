ALTER TABLE public.meeting_rooms DROP CONSTRAINT IF EXISTS meeting_rooms_owner_wallet_key;
CREATE INDEX IF NOT EXISTS meeting_rooms_owner_idx ON public.meeting_rooms(owner_wallet, created_at);
ALTER TABLE public.meeting_rooms
  ADD COLUMN IF NOT EXISTS purpose text,
  ADD COLUMN IF NOT EXISTS join_sound boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS approve_team boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS approve_viewers boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS archived_at timestamptz;

CREATE TABLE public.meeting_join_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id uuid NOT NULL REFERENCES public.meeting_rooms(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('participant', 'viewer')),
  display_name text NOT NULL,
  token_hash text NOT NULL,
  status text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'admitted', 'denied', 'joined')),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz
);
CREATE INDEX meeting_join_requests_room_idx ON public.meeting_join_requests(room_id, status, last_seen_at DESC);
GRANT ALL ON public.meeting_join_requests TO service_role;
ALTER TABLE public.meeting_join_requests ENABLE ROW LEVEL SECURITY;