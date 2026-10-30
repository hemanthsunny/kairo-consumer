create or replace function public.delete_refresh_token(p_secret_id uuid)
returns void language sql security definer set search_path = '' as $$
  delete from vault.secrets where id = p_secret_id;
$$;
revoke all on function public.delete_refresh_token(uuid) from public, anon, authenticated;
grant execute on function public.delete_refresh_token(uuid) to service_role;

create or replace function public.is_reserved_handle(h text) returns boolean
language sql immutable set search_path = '' as $$
  select h = any (array['app','api','b','login','signup','logout','pricing','privacy','terms','help','support',
    'about','admin','settings','manage','book','booking','public','static','assets','www','mail','blog','kairo','link']);
$$;
alter table public.profiles add constraint profiles_handle_not_reserved check (not public.is_reserved_handle(handle));

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  base text;
  candidate text;
  n int := 0;
begin
  base := lower(regexp_replace(split_part(coalesce(new.email, 'user'), '@', 1), '[^a-z0-9]+', '-', 'gi'));
  base := trim(both '-' from base);
  if length(base) < 3 then base := base || '-me'; end if;
  base := left(base, 24);
  if public.is_reserved_handle(base) then base := base || '-me'; end if;
  candidate := base;
  while exists (select 1 from public.profiles where handle = candidate) loop
    n := n + 1;
    candidate := base || '-' || n::text;
  end loop;
  insert into public.profiles (id, handle, email, full_name)
  values (new.id, candidate, new.email,
          coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name'));
  return new;
end $$;

create or replace function public.account_tokens_cleanup() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  delete from vault.secrets where id = old.refresh_token_secret_id;
  return old;
end $$;
create trigger account_tokens_cleanup after delete on public.account_tokens
for each row execute function public.account_tokens_cleanup();
