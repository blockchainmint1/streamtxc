-- Hide HD wallet derivation_index from public Data API on videos
REVOKE SELECT (derivation_index) ON public.videos FROM anon, authenticated;

-- wallet_notification_prefs is only ever read/written via server functions using service_role.
-- Strip all anon/authenticated Data API access to eliminate the exposure surface.
REVOKE SELECT, INSERT, UPDATE, DELETE ON public.wallet_notification_prefs FROM anon, authenticated;

-- Ensure service_role retains full access for server-side code
GRANT ALL ON public.wallet_notification_prefs TO service_role;
GRANT ALL ON public.videos TO service_role;
GRANT ALL ON public.comment_boosts TO service_role;