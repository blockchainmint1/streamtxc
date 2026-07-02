-- Ensure vault extension is available (installed by default on Supabase).
CREATE EXTENSION IF NOT EXISTS supabase_vault;

-- Placeholder secret; the real value is written outside migrations via a
-- one-shot admin script that reads TXC_RPC_PASS from server env. This
-- migration only guarantees the row exists so the cron command can
-- reference it by name.
DO $$
DECLARE
  existing uuid;
BEGIN
  SELECT id INTO existing FROM vault.secrets WHERE name = 'txc_rpc_pass';
  IF existing IS NULL THEN
    PERFORM vault.create_secret('__unset__', 'txc_rpc_pass', 'RPC admin token for internal cron hooks');
  END IF;
END $$;

SELECT cron.unschedule('finalize-stuck-hls');
SELECT cron.schedule(
  'finalize-stuck-hls',
  '*/5 * * * *',
  $cmd$
  SELECT net.http_post(
    url := 'https://project--d4d0978e-e0a5-482f-8316-fceaa9ec6a46.lovable.app/api/public/hooks/finalize-stuck-hls?limit=15&minAgeMin=3',
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'x-admin-token', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'txc_rpc_pass' LIMIT 1)
    ),
    body := '{}'::jsonb
  );
  $cmd$
);