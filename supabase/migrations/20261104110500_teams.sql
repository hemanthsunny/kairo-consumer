-- Teams: a business team with its own address (link.kairohr.co/<team>), members with roles,
-- shared booking links (each link picks which members attend) and internal "find a time" calls.
-- Replaces the per-link group members added earlier the same day.

create table public.teams (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  handle text not null unique check (handle ~ '^[a-z0-9][a-z0-9-]{2,30}$' and not public.is_reserved_handle(handle)),
  name text not null check (length(name) between 1 and 80),
  description text,
  created_at timestamptz not null default now()
);

create table public.team_members (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  email text not null check (email = lower(email)),
  user_id uuid references public.profiles(id) on delete cascade,
  role text not null default 'member' check (role in ('owner','admin','member')),
  status text not null default 'invited' check (status in ('invited','active','declined')),
  invite_token text not null unique default encode(extensions.gen_random_bytes(18), 'hex'),
  invited_by uuid references public.profiles(id) on delete set null,
  invited_at timestamptz not null default now(),
  joined_at timestamptz,
  unique (team_id, email)
);
create index team_members_user on public.team_members(user_id) where status = 'active';
create unique index team_members_one_per_user on public.team_members(team_id, user_id) where user_id is not null;

alter table public.teams enable row level security;
alter table public.team_members enable row level security;
-- all team reads and writes go through the API (service role); no client policies

-- team booking links: the creator is links.user_id; attendee_ids null = every active member
alter table public.links add column team_id uuid references public.teams(id) on delete cascade;
alter table public.links add column attendee_ids uuid[];
alter table public.links drop constraint links_user_id_slug_key;
create unique index links_personal_slug on public.links(user_id, slug) where team_id is null;
create unique index links_team_slug on public.links(team_id, slug) where team_id is not null;

-- personal links stay editable from the app; team links only through the API
drop policy "own links all" on public.links;
create policy "own personal links" on public.links for all to authenticated
  using (user_id = (select auth.uid()) and team_id is null)
  with check (user_id = (select auth.uid()) and team_id is null);

-- bookings: who attends (for reminders) and whether it's an internal team call
alter table public.bookings add column team_id uuid references public.teams(id) on delete set null;
alter table public.bookings add column attendee_user_ids uuid[];
alter table public.bookings add column internal boolean not null default false;
create index bookings_attendees on public.bookings using gin (attendee_user_ids);

-- free plan limit counts personal links only
create or replace function public.enforce_free_link_limit() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.team_id is null and new.is_active and not public.is_premium(new.user_id)
     and (tg_op = 'INSERT' or not old.is_active)
     and (select count(*) from public.links where user_id = new.user_id and team_id is null and is_active and id <> new.id) >= 1 then
    raise exception 'FREE_LIMIT_LINKS: The free plan includes 1 active booking link. Go Premium for unlimited links, or turn off your other link first.'
      using errcode = 'P0001';
  end if;
  return new;
end $$;

-- personal and team addresses share one namespace
create or replace function public.team_handle_free() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.profiles where handle = new.handle) then
    raise exception 'That address is taken' using errcode = '23505';
  end if;
  return new;
end $$;
create trigger teams_handle_free before insert or update of handle on public.teams
for each row execute function public.team_handle_free();

create or replace function public.profile_handle_free() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.teams where handle = new.handle) then
    if tg_op = 'INSERT' then
      new.handle := left(new.handle, 24) || '-' || substr(md5(random()::text), 1, 4);
    else
      raise exception 'That address is taken' using errcode = '23505';
    end if;
  end if;
  return new;
end $$;
create trigger profiles_handle_free before insert or update of handle on public.profiles
for each row execute function public.profile_handle_free();

revoke execute on function public.team_handle_free() from public, anon, authenticated;
revoke execute on function public.profile_handle_free() from public, anon, authenticated;

-- move this morning's group links into teams (one team per group link)
do $$
declare
  l record;
  t uuid;
  h text;
  owner_email text;
begin
  for l in select distinct lk.* from public.links lk join public.link_members m on m.link_id = lk.id loop
    h := l.slug;
    if exists (select 1 from public.profiles where handle = h) or exists (select 1 from public.teams where handle = h) or public.is_reserved_handle(h) or length(h) < 3 then
      h := left(l.slug, 24) || '-team';
    end if;
    select email into owner_email from public.profiles where id = l.user_id;
    insert into public.teams (owner_id, handle, name) values (l.user_id, h, l.title) returning id into t;
    insert into public.team_members (team_id, email, user_id, role, status, joined_at)
      values (t, coalesce(lower(owner_email), 'owner-' || l.user_id::text), l.user_id, 'owner', 'active', now());
    insert into public.team_members (team_id, email, user_id, role, status, invite_token, invited_by, invited_at, joined_at)
      select t, m.email, m.user_id, 'member', m.status, m.invite_token, l.user_id, m.invited_at, m.joined_at
      from public.link_members m where m.link_id = l.id
      on conflict do nothing;
    update public.links set team_id = t, slug = case when l.slug = h then l.duration_min::text || 'min' else l.slug end where id = l.id;
  end loop;
end $$;

drop table public.link_members;
