CREATE OR REPLACE FUNCTION public.next_video_wallet_index()
RETURNS bigint
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT nextval('public.video_wallet_index_seq');
$$;
