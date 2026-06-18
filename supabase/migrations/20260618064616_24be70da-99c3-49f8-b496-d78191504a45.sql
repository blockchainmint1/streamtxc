ALTER TABLE public.videos
  ADD COLUMN IF NOT EXISTS transcript_text TEXT,
  ADD COLUMN IF NOT EXISTS transcript_cid TEXT,
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'upload';

UPDATE public.videos SET source = 'upload' WHERE source IS NULL;