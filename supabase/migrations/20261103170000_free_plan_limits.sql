-- Premium caps: 300 WhatsApp + 50 SMS a month
update public.app_settings set value = '{"whatsapp":300,"sms":50}'::jsonb where key = 'premium_monthly_caps';

-- Free plan: up to 3 connected calendars, 1 active booking link
create or replace function public.is_premium(p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select plan = 'premium' from public.profiles where id = p_user), false);
$$;
revoke all on function public.is_premium(uuid) from public, anon, authenticated;

create or replace function public.enforce_free_calendar_limit() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_premium(new.user_id)
     and (select count(*) from public.connected_accounts where user_id = new.user_id) >= 3 then
    raise exception 'FREE_LIMIT_CALENDARS: The free plan includes up to 3 calendars. Go Premium to connect more.'
      using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger connected_accounts_free_limit before insert on public.connected_accounts
for each row execute function public.enforce_free_calendar_limit();

create or replace function public.enforce_free_link_limit() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.is_active and not public.is_premium(new.user_id)
     and (tg_op = 'INSERT' or not old.is_active)
     and (select count(*) from public.links where user_id = new.user_id and is_active and id <> new.id) >= 1 then
    raise exception 'FREE_LIMIT_LINKS: The free plan includes 1 active booking link. Go Premium for unlimited links, or turn off your other link first.'
      using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger links_free_limit before insert or update on public.links
for each row execute function public.enforce_free_link_limit();

revoke execute on function public.enforce_free_calendar_limit() from public, anon, authenticated;
revoke execute on function public.enforce_free_link_limit() from public, anon, authenticated;
