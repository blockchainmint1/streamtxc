ALTER TABLE public.videos
  ADD COLUMN IF NOT EXISTS hls_cid text,
  ADD COLUMN IF NOT EXISTS renditions jsonb,
  ADD COLUMN IF NOT EXISTS transcode_status text,
  ADD COLUMN IF NOT EXISTS transcode_job_id text,
  ADD COLUMN IF NOT EXISTS transcode_error text,
  ADD COLUMN IF NOT EXISTS transcode_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS transcode_completed_at timestamptz;

CREATE INDEX IF NOT EXISTS videos_transcode_job_id_idx ON public.videos (transcode_job_id);
CREATE INDEX IF NOT EXISTS videos_transcode_status_idx ON public.videos (transcode_status);