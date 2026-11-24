ALTER TABLE public.restream_destinations ADD COLUMN IF NOT EXISTS room_id uuid REFERENCES public.meeting_rooms(id) ON DELETE CASCADE;
ALTER TABLE public.live_push_sites ADD COLUMN IF NOT EXISTS room_id uuid REFERENCES public.meeting_rooms(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS restream_destinations_room_idx ON public.restream_destinations(room_id);
CREATE INDEX IF NOT EXISTS live_push_sites_room_idx ON public.live_push_sites(room_id);
COMMENT ON COLUMN public.restream_destinations.room_id IS 'Studio this destination belongs to; null = every stream';
COMMENT ON COLUMN public.live_push_sites.room_id IS 'Studio this site belongs to; null = every stream';