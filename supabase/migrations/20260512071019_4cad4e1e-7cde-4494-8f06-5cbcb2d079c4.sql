-- Deduplicate any existing duplicate CIDs (keep earliest)
DELETE FROM public.videos a USING public.videos b
WHERE a.cid = b.cid AND a.created_at > b.created_at;

ALTER TABLE public.videos ADD CONSTRAINT videos_cid_unique UNIQUE (cid);