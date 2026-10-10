ALTER TABLE public.videos
  ADD COLUMN IF NOT EXISTS notified_3d_at timestamptz,
  ADD COLUMN IF NOT EXISTS notified_1d_at timestamptz;