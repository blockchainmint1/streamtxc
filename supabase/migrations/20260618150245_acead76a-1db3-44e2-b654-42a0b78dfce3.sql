-- Draft-first upload restructure.

ALTER TABLE public.videos ADD COLUMN IF NOT EXISTS id uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE public.videos ADD COLUMN IF NOT EXISTS draft_owner_token text;

-- Drop dependent FKs, swap the PK, recreate FKs pointing at the still-unique cid.
ALTER TABLE public.payments DROP CONSTRAINT IF EXISTS payments_video_cid_fkey;
ALTER TABLE public.view_events DROP CONSTRAINT IF EXISTS view_events_video_cid_fkey;

DO $$
DECLARE pk_name text;
BEGIN
  SELECT conname INTO pk_name FROM pg_constraint
   WHERE conrelid = 'public.videos'::regclass AND contype = 'p';
  IF pk_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.videos DROP CONSTRAINT %I', pk_name);
  END IF;
END $$;

ALTER TABLE public.videos ADD CONSTRAINT videos_pkey PRIMARY KEY (id);
ALTER TABLE public.videos ALTER COLUMN cid DROP NOT NULL;
ALTER TABLE public.videos ADD CONSTRAINT videos_cid_key UNIQUE (cid);
ALTER TABLE public.videos ALTER COLUMN title SET DEFAULT '';

ALTER TABLE public.payments
  ADD CONSTRAINT payments_video_cid_fkey
  FOREIGN KEY (video_cid) REFERENCES public.videos(cid) ON DELETE CASCADE;

ALTER TABLE public.view_events
  ADD CONSTRAINT view_events_video_cid_fkey
  FOREIGN KEY (video_cid) REFERENCES public.videos(cid) ON DELETE CASCADE;

-- Garbage-collect abandoned drafts hourly.
CREATE EXTENSION IF NOT EXISTS pg_cron;

DO $$ BEGIN
  PERFORM cron.unschedule('cleanup-upload-drafts');
EXCEPTION WHEN OTHERS THEN NULL; END $$;

SELECT cron.schedule(
  'cleanup-upload-drafts',
  '17 * * * *',
  $$DELETE FROM public.videos WHERE status='draft' AND cid IS NULL AND created_at < now() - interval '24 hours'$$
);