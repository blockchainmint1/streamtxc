-- Remove public SELECT on tables exposing IP hashes; access remains via service-role only
DROP POLICY IF EXISTS "Anyone can view video_reports" ON public.video_reports;
DROP POLICY IF EXISTS "Anyone can view view_events" ON public.view_events;

-- Explicit deny-by-default for video-uploads bucket; service-role bypasses RLS
CREATE POLICY "video-uploads: deny anon select"
  ON storage.objects FOR SELECT TO anon, authenticated
  USING (bucket_id <> 'video-uploads');

CREATE POLICY "video-uploads: deny anon insert"
  ON storage.objects FOR INSERT TO anon, authenticated
  WITH CHECK (bucket_id <> 'video-uploads');

CREATE POLICY "video-uploads: deny anon update"
  ON storage.objects FOR UPDATE TO anon, authenticated
  USING (bucket_id <> 'video-uploads')
  WITH CHECK (bucket_id <> 'video-uploads');

CREATE POLICY "video-uploads: deny anon delete"
  ON storage.objects FOR DELETE TO anon, authenticated
  USING (bucket_id <> 'video-uploads');