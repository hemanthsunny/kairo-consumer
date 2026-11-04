-- Group links: a link can include other people. Times are offered only when everyone is free,
-- and each booking is added to everyone's calendar.
create table public.link_members (
  id uuid primary key default gen_random_uuid(),
  link_id uuid not null references public.links(id) on delete cascade,
  email text not null check (email = lower(email)),
  user_id uuid references public.profiles(id) on delete cascade,
  status text not null default 'invited' check (status in ('invited','active','declined')),
  invite_token text not null unique default encode(extensions.gen_random_bytes(18), 'hex'),
  invited_at timestamptz not null default now(),
  joined_at timestamptz,
  unique (link_id, email)
);
create index link_members_user on public.link_members(user_id) where status = 'active';
alter table public.link_members enable row level security;

-- owners see who is on their links; members see their own rows. All writes go through the API.
create policy "link members read" on public.link_members for select to authenticated using (
  user_id = (select auth.uid())
  or exists (select 1 from public.links l where l.id = link_id and l.user_id = (select auth.uid()))
);

create or replace function public.is_reserved_handle(h text) returns boolean
language sql immutable set search_path = '' as $$
  select h = any (array['app','api','b','login','signup','logout','pricing','privacy','terms','help','support',
    'about','admin','settings','manage','book','booking','public','static','assets','www','mail','blog','kairo','link',
    'invite','join','team','teams']);
$$;
