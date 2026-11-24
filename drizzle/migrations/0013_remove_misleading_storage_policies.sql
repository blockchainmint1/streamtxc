DROP POLICY IF EXISTS "video-uploads: deny anon select" ON storage.objects;
DROP POLICY IF EXISTS "video-uploads: deny anon insert" ON storage.objects;
DROP POLICY IF EXISTS "video-uploads: deny anon update" ON storage.objects;
DROP POLICY IF EXISTS "video-uploads: deny anon delete" ON storage.objects;