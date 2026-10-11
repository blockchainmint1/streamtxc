ALTER TABLE public.hm_sso_links ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active';
ALTER TABLE public.hm_sso_links ADD COLUMN IF NOT EXISTS full_name text;