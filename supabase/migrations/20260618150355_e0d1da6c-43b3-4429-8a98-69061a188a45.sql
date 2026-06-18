ALTER TABLE public.payments DROP CONSTRAINT IF EXISTS payments_video_cid_fkey;
ALTER TABLE public.view_events DROP CONSTRAINT IF EXISTS view_events_video_cid_fkey;
ALTER TABLE public.videos DROP CONSTRAINT IF EXISTS videos_pkey;
ALTER TABLE public.videos DROP CONSTRAINT IF EXISTS videos_cid_key;
ALTER TABLE public.videos DROP CONSTRAINT IF EXISTS videos_cid_unique;
DROP INDEX IF EXISTS public.videos_cid_unique;
DELETE FROM public.videos WHERE cid IS NULL;
ALTER TABLE public.videos ALTER COLUMN cid SET NOT NULL;
ALTER TABLE public.videos ADD CONSTRAINT videos_pkey PRIMARY KEY (cid);
ALTER TABLE public.videos DROP COLUMN IF EXISTS id;
ALTER TABLE public.videos DROP COLUMN IF EXISTS draft_owner_token;
ALTER TABLE public.videos ALTER COLUMN title DROP DEFAULT;

ALTER TABLE public.payments
  ADD CONSTRAINT payments_video_cid_fkey
  FOREIGN KEY (video_cid) REFERENCES public.videos(cid) ON DELETE CASCADE;
ALTER TABLE public.view_events
  ADD CONSTRAINT view_events_video_cid_fkey
  FOREIGN KEY (video_cid) REFERENCES public.videos(cid) ON DELETE CASCADE;

CREATE TABLE IF NOT EXISTS public.video_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_token text NOT NULL,
  wallet text,
  title text NOT NULL DEFAULT '',
  description text,
  thumbnail_cid text,
  is_nsfw boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT ALL ON public.video_drafts TO service_role;
ALTER TABLE public.video_drafts ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.tg_video_drafts_updated_at()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

DROP TRIGGER IF EXISTS video_drafts_updated_at ON public.video_drafts;
CREATE TRIGGER video_drafts_updated_at
  BEFORE UPDATE ON public.video_drafts
  FOR EACH ROW EXECUTE FUNCTION public.tg_video_drafts_updated_at();

DO $$ BEGIN
  PERFORM cron.unschedule('cleanup-upload-drafts');
EXCEPTION WHEN OTHERS THEN NULL; END $$;

SELECT cron.schedule(
  'cleanup-upload-drafts',
  '17 * * * *',
  $$DELETE FROM public.video_drafts WHERE created_at < now() - interval '24 hours'$$
);