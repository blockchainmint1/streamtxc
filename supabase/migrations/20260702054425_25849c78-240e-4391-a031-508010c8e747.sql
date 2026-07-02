-- ============ live_chat_messages: hide raw wallet, expose short display_name ============

-- Backfill display_name for existing rows: first 6 + last 4 of wallet with ellipsis.
UPDATE public.live_chat_messages
SET display_name = substring(wallet from 1 for 6) || '…' || substring(wallet from length(wallet) - 3)
WHERE display_name IS NULL AND wallet IS NOT NULL;

-- Revoke broad SELECT, then grant SELECT only on non-sensitive columns.
-- Realtime postgres_changes payloads honor column-level SELECT grants, so
-- anon/authenticated subscribers will no longer receive the wallet column.
REVOKE SELECT ON public.live_chat_messages FROM anon;
REVOKE SELECT ON public.live_chat_messages FROM authenticated;

GRANT SELECT (id, stream_id, display_name, body, created_at) ON public.live_chat_messages TO anon;
GRANT SELECT (id, stream_id, display_name, body, created_at) ON public.live_chat_messages TO authenticated;

-- service_role (used by supabaseAdmin server fns) keeps full access.
GRANT ALL ON public.live_chat_messages TO service_role;

-- ============ live_streams: hide sensitive infra columns from public ============

REVOKE SELECT ON public.live_streams FROM anon;
REVOKE SELECT ON public.live_streams FROM authenticated;

GRANT SELECT (
  id,
  title,
  description,
  thumbnail_cid,
  status,
  scheduled_for,
  started_at,
  ended_at,
  hls_url,
  simulcast_youtube_url,
  simulcast_twitter_url,
  simulcast_facebook_url,
  peak_viewers,
  total_views,
  archive_video_cid,
  archive_status,
  created_at,
  updated_at
) ON public.live_streams TO anon;

GRANT SELECT (
  id,
  title,
  description,
  thumbnail_cid,
  status,
  scheduled_for,
  started_at,
  ended_at,
  hls_url,
  simulcast_youtube_url,
  simulcast_twitter_url,
  simulcast_facebook_url,
  peak_viewers,
  total_views,
  archive_video_cid,
  archive_status,
  created_at,
  updated_at
) ON public.live_streams TO authenticated;

GRANT ALL ON public.live_streams TO service_role;
