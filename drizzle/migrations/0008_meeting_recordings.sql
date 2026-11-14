ALTER TABLE public.meeting_rooms
  ADD COLUMN IF NOT EXISTS auto_record boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS auto_notes boolean NOT NULL DEFAULT false;

CREATE TABLE public.meeting_recordings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id uuid NOT NULL REFERENCES public.meeting_rooms(id) ON DELETE CASCADE,
  owner_wallet text NOT NULL,
  title text NOT NULL,
  chime_meeting_id text NOT NULL,
  record_video boolean NOT NULL DEFAULT true,
  take_notes boolean NOT NULL DEFAULT false,
  capture_pipeline_id text,
  capture_pipeline_arn text,
  concat_pipeline_id text,
  transcription_started boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'recording' CHECK (status IN ('recording', 'processing', 'ready', 'failed')),
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  video_key text,
  video_bytes bigint,
  transcript jsonb,
  transcript_text text,
  notes_status text NOT NULL DEFAULT 'none' CHECK (notes_status IN ('none', 'pending', 'ready', 'failed')),
  summary text,
  key_points jsonb,
  decisions jsonb,
  action_items jsonb,
  publish_status text NOT NULL DEFAULT 'private' CHECK (publish_status IN ('private', 'transcoding', 'pinning', 'published', 'failed')),
  publish_job_id text,
  published_cid text,
  error text,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX meeting_recordings_room_idx ON public.meeting_recordings(room_id, started_at DESC);
CREATE INDEX meeting_recordings_status_idx ON public.meeting_recordings(status);
CREATE INDEX meeting_recordings_publish_idx ON public.meeting_recordings(publish_status);
CREATE UNIQUE INDEX meeting_recordings_one_active ON public.meeting_recordings(room_id) WHERE status = 'recording';
GRANT ALL ON public.meeting_recordings TO service_role;
ALTER TABLE public.meeting_recordings ENABLE ROW LEVEL SECURITY;