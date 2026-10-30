create extension if not exists btree_gist with schema extensions;
create extension if not exists pgcrypto with schema extensions;

-- profiles ----------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  handle text unique not null check (handle ~ '^[a-z0-9][a-z0-9-]{2,30}$'),
  full_name text,
  email text,
  timezone text not null default 'Europe/London',
  phone_e164 text check (phone_e164 is null or phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  phone_verified boolean not null default false,
  reminder_channels text[] not null default array['email'],
  plan text not null default 'trial' check (plan in ('trial','basic','premium','inactive')),
  trial_ends_at timestamptz not null default now() + interval '14 days',
  onboarded boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- connected calendar accounts (one per email) --------------------------------
create table public.connected_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  provider text not null check (provider in ('google','microsoft')),
  email text not null,
  label text not null default 'Personal',
  color text not null default '#6366f1',
  status text not null default 'active' check (status in ('active','error','revoked')),
  last_error text,
  created_at timestamptz not null default now(),
  unique (user_id, provider, email)
);

-- tokens: service-role only (no RLS policies) ------------------------------
create table public.account_tokens (
  account_id uuid primary key references public.connected_accounts(id) on delete cascade,
  refresh_token_secret_id uuid not null,
  access_token text,
  access_expires_at timestamptz,
  scopes text,
  updated_at timestamptz not null default now()
);

create table public.calendars (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  account_id uuid not null references public.connected_accounts(id) on delete cascade,
  provider_calendar_id text not null,
  name text not null,
  is_primary boolean not null default false,
  can_write boolean not null default false,
  check_conflicts boolean not null default true,
  created_at timestamptz not null default now(),
  unique (account_id, provider_calendar_id)
);

-- booking links -------------------------------------------------------------
create table public.links (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  slug text not null check (slug ~ '^[a-z0-9][a-z0-9-]{0,40}$'),
  title text not null,
  description text,
  duration_min int not null default 30 check (duration_min between 5 and 480),
  buffer_before_min int not null default 0 check (buffer_before_min between 0 and 240),
  buffer_after_min int not null default 0 check (buffer_after_min between 0 and 240),
  min_notice_min int not null default 240 check (min_notice_min between 0 and 20160),
  max_days_ahead int not null default 30 check (max_days_ahead between 1 and 60),
  daily_limit int check (daily_limit is null or daily_limit between 1 and 50),
  slot_step_min int not null default 30 check (slot_step_min in (10,15,20,30,60)),
  write_calendar_id uuid references public.calendars(id) on delete set null,
  location_type text not null default 'auto' check (location_type in ('auto','custom_url','phone','in_person','none')),
  location_value text,
  weekly_hours jsonb not null default '{"mon":[["09:00","17:00"]],"tue":[["09:00","17:00"]],"wed":[["09:00","17:00"]],"thu":[["09:00","17:00"]],"fri":[["09:00","17:00"]],"sat":[],"sun":[]}'::jsonb,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, slug)
);

-- bookings ------------------------------------------------------------------
create table public.bookings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  link_id uuid references public.links(id) on delete set null,
  title text not null,
  guest_name text not null,
  guest_email text not null,
  guest_phone text,
  guest_note text,
  guest_timezone text,
  start_at timestamptz not null,
  end_at timestamptz not null,
  status text not null default 'confirmed' check (status in ('confirmed','cancelled')),
  cancelled_by text check (cancelled_by in ('host','guest')),
  cancel_reason text,
  write_account_id uuid references public.connected_accounts(id) on delete set null,
  write_calendar_provider_id text,
  provider_event_id text,
  meeting_url text,
  location_text text,
  manage_token uuid not null default gen_random_uuid() unique,
  created_at timestamptz not null default now(),
  cancelled_at timestamptz,
  check (end_at > start_at),
  constraint bookings_no_overlap exclude using gist (
    user_id with =, tstzrange(start_at, end_at) with &&
  ) where (status = 'confirmed')
);
create index bookings_user_start on public.bookings(user_id, start_at);

-- notifications -------------------------------------------------------------
create table public.notification_outbox (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  booking_id uuid references public.bookings(id) on delete cascade,
  recipient text not null check (recipient in ('host','guest')),
  channel text not null check (channel in ('email','whatsapp','sms')),
  kind text not null check (kind in ('confirmation','reminder_24h','reminder_1h','cancellation')),
  send_at timestamptz not null,
  status text not null default 'pending' check (status in ('pending','sending','sent','failed','skipped')),
  attempts int not null default 0,
  last_error text,
  provider_message_id text,
  sent_at timestamptz,
  dedupe_key text not null unique,
  created_at timestamptz not null default now()
);
create index outbox_due on public.notification_outbox(send_at) where status = 'pending';

-- billing ------------------------------------------------------------------
create table public.subscriptions (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  stripe_customer_id text unique,
  stripe_subscription_id text unique,
  plan text check (plan in ('basic','premium')),
  interval text check (interval in ('month','year')),
  status text,
  current_period_end timestamptz,
  updated_at timestamptz not null default now()
);

-- service-only helpers -----------------------------------------------------------
create table public.oauth_states (
  state text primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  provider text not null,
  code_verifier text,
  return_to text,
  created_at timestamptz not null default now()
);

create table public.busy_cache (
  account_id uuid primary key references public.connected_accounts(id) on delete cascade,
  range_start timestamptz not null,
  range_end timestamptz not null,
  busy jsonb not null,
  fetched_at timestamptz not null default now()
);

create table public.app_settings (
  key text primary key,
  value jsonb not null
);
insert into public.app_settings(key, value) values
  ('reminders_enabled', 'true'::jsonb),
  ('whatsapp_enabled', 'false'::jsonb),
  ('sms_enabled', 'false'::jsonb),
  ('premium_monthly_caps', '{"whatsapp":150,"sms":30}'::jsonb);

-- RLS ---------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.connected_accounts enable row level security;
alter table public.account_tokens enable row level security;
alter table public.calendars enable row level security;
alter table public.links enable row level security;
alter table public.bookings enable row level security;
alter table public.notification_outbox enable row level security;
alter table public.subscriptions enable row level security;
alter table public.oauth_states enable row level security;
alter table public.busy_cache enable row level security;
alter table public.app_settings enable row level security;

create policy "own profile read" on public.profiles for select to authenticated using (id = (select auth.uid()));
create policy "own profile update" on public.profiles for update to authenticated using (id = (select auth.uid())) with check (id = (select auth.uid()));

create policy "own accounts read" on public.connected_accounts for select to authenticated using (user_id = (select auth.uid()));
create policy "own accounts update" on public.connected_accounts for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "own accounts delete" on public.connected_accounts for delete to authenticated using (user_id = (select auth.uid()));

create policy "own calendars read" on public.calendars for select to authenticated using (user_id = (select auth.uid()));
create policy "own calendars update" on public.calendars for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create policy "own links all" on public.links for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create policy "own bookings read" on public.bookings for select to authenticated using (user_id = (select auth.uid()));

create policy "own subscription read" on public.subscriptions for select to authenticated using (user_id = (select auth.uid()));

-- users may not change billing-controlled columns on profiles
create or replace function public.protect_profile_columns() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (select auth.role()) = 'authenticated' then
    new.plan := old.plan;
    new.trial_ends_at := old.trial_ends_at;
    new.phone_verified := case when new.phone_e164 is distinct from old.phone_e164 then false else old.phone_verified end;
    new.id := old.id;
  end if;
  new.updated_at := now();
  return new;
end $$;
create trigger profiles_protect before update on public.profiles
for each row execute function public.protect_profile_columns();

create or replace function public.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin new.updated_at := now(); return new; end $$;
create trigger links_touch before update on public.links
for each row execute function public.touch_updated_at();

-- profile on signup with a unique handle (replaced in a later migration)
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
create trigger on_auth_user_created after insert on auth.users
for each row execute function public.handle_new_user();

-- vault helpers callable only by service role
create or replace function public.store_refresh_token(p_account_id uuid, p_token text, p_existing uuid default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare sid uuid;
begin
  if p_existing is not null then
    perform vault.update_secret(p_existing, p_token);
    return p_existing;
  end if;
  sid := vault.create_secret(p_token, 'refresh_' || p_account_id::text);
  return sid;
end $$;

create or replace function public.read_refresh_token(p_secret_id uuid)
returns text language sql security definer set search_path = '' as $$
  select decrypted_secret from vault.decrypted_secrets where id = p_secret_id;
$$;

revoke all on function public.store_refresh_token(uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.read_refresh_token(uuid) from public, anon, authenticated;
grant execute on function public.store_refresh_token(uuid, text, uuid) to service_role;
grant execute on function public.read_refresh_token(uuid) to service_role;
