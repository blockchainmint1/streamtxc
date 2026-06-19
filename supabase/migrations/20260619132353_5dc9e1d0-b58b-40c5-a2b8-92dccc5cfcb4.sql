
CREATE TABLE public.bug_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  name text,
  email text,
  telegram text,
  details text NOT NULL,
  attachment_name text,
  attachment_type text,
  attachment_data_url text,
  page_url text,
  user_agent text,
  reporter_wallet text
);

GRANT SELECT, INSERT ON public.bug_reports TO authenticated;
GRANT ALL ON public.bug_reports TO service_role;

ALTER TABLE public.bug_reports ENABLE ROW LEVEL SECURITY;
-- No policies: all access goes through server functions using supabaseAdmin.
