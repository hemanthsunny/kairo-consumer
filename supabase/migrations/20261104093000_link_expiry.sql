-- Links can close automatically (group links default to 7 days, set in the app).
alter table public.links add column expires_at timestamptz;

create or replace function public.close_expired_link() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.expires_at is not null and new.expires_at <= now() then new.is_active := false; end if;
  return new;
end $$;
create trigger links_close_expired before insert or update on public.links
for each row execute function public.close_expired_link();
revoke execute on function public.close_expired_link() from public, anon, authenticated;

select cron.schedule('kairo-link-close-expired', '* * * * *',
  $$update public.links set is_active = false where is_active and expires_at is not null and expires_at <= now()$$);
