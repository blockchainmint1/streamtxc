-- Lock down imports table: was publicly readable, exposing Dropbox URLs.
DROP POLICY IF EXISTS "Anyone can view imports" ON public.imports;

-- video-uploads bucket: no longer used by app code (uploads pipe straight
-- to Pinata via the server). Drop the open SELECT and INSERT policies so
-- the bucket is service-role-only.
DROP POLICY IF EXISTS "Public can read own buffered uploads" ON storage.objects;
DROP POLICY IF EXISTS "Public can upload videos to buffer" ON storage.objects;