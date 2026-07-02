SELECT cron.unschedule('finalize-stuck-hls');
SELECT cron.schedule(
  'finalize-stuck-hls',
  '*/5 * * * *',
  format($cmd$
  SELECT net.http_post(
    url := 'https://project--d4d0978e-e0a5-482f-8316-fceaa9ec6a46.lovable.app/api/public/hooks/finalize-stuck-hls?limit=15&minAgeMin=3',
    headers := jsonb_build_object('Content-Type','application/json','x-admin-token', %L),
    body := '{}'::jsonb
  );
  $cmd$, current_setting('app.txc_rpc_pass', true))
);