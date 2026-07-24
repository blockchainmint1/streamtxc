SELECT cron.unschedule('finalize-live-archive');
SELECT cron.schedule('finalize-live-archive', '*/5 * * * *', $job$
  SELECT net.http_post(
    url := 'https://project--d4d0978e-e0a5-482f-8316-fceaa9ec6a46.lovable.app/api/public/hooks/finalize-live-archive',
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'x-admin-token', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'txc_rpc_pass' LIMIT 1)
    ),
    body := '{}'::jsonb
  );
$job$);

SELECT cron.unschedule('live-billing-tick');
SELECT cron.schedule('live-billing-tick', '* * * * *', $job$
  SELECT net.http_post(
    url := 'https://project--d4d0978e-e0a5-482f-8316-fceaa9ec6a46.lovable.app/api/public/hooks/live-billing-tick',
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'x-admin-token', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'txc_rpc_pass' LIMIT 1)
    ),
    body := '{}'::jsonb
  );
$job$);

SELECT net.http_post(
  url := 'https://project--d4d0978e-e0a5-482f-8316-fceaa9ec6a46.lovable.app/api/public/hooks/finalize-live-archive',
  headers := jsonb_build_object(
    'Content-Type','application/json',
    'x-admin-token', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'txc_rpc_pass' LIMIT 1)
  ),
  body := '{}'::jsonb
);