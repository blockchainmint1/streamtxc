-- Reports table
CREATE TABLE public.video_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  video_cid text NOT NULL,
  reason text NOT NULL CHECK (reason IN ('nsfw','csam','violence','copyright','illegal','spam','other')),
  details text,
  reporter_ip_hash text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','upheld','dismissed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz,
  reviewer_note text
);

CREATE INDEX video_reports_cid_idx ON public.video_reports(video_cid);
CREATE INDEX video_reports_status_idx ON public.video_reports(status);
CREATE UNIQUE INDEX video_reports_unique_ip_cid ON public.video_reports(video_cid, reporter_ip_hash);

ALTER TABLE public.video_reports ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can view video_reports"
  ON public.video_reports FOR SELECT
  USING (true);

-- Add hide/report columns to videos
ALTER TABLE public.videos
  ADD COLUMN report_count integer NOT NULL DEFAULT 0,
  ADD COLUMN hidden_at timestamptz,
  ADD COLUMN hidden_reason text;

CREATE INDEX videos_hidden_at_idx ON public.videos(hidden_at);