create extension if not exists pg_cron;
create extension if not exists pg_net;

select vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'cron_secret')
where not exists (select 1 from vault.secrets where name = 'cron_secret');

create or replace function public.read_cron_secret() returns text
language sql security definer set search_path = '' as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret' limit 1;
$$;
revoke all on function public.read_cron_secret() from public, anon, authenticated;
grant execute on function public.read_cron_secret() to service_role;

select cron.schedule(
  'kairo-link-reminders',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := 'https://aqzbnqbuxvbgwtendieh.supabase.co/functions/v1/api/cron/reminders',
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret' limit 1)
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000
  );
  $$
);
