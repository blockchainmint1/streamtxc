REVOKE EXECUTE ON FUNCTION public.next_video_wallet_index() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.next_video_wallet_index() TO service_role;
