ALTER TABLE public.videos ADD COLUMN IF NOT EXISTS is_nsfw boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_videos_is_nsfw ON public.videos(is_nsfw) WHERE is_nsfw = false;