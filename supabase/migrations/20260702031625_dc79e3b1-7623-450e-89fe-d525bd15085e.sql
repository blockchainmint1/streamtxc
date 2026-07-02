ALTER TABLE public.live_streams
  ADD COLUMN IF NOT EXISTS archive_status text,
  ADD COLUMN IF NOT EXISTS archive_output_prefix text,
  ADD COLUMN IF NOT EXISTS archive_error text;

ALTER TABLE public.live_streams
  DROP CONSTRAINT IF EXISTS live_streams_archive_status_check;

ALTER TABLE public.live_streams
  ADD CONSTRAINT live_streams_archive_status_check
  CHECK (archive_status IS NULL OR archive_status IN ('transcoding','pinning','ready','failed','skipped'));