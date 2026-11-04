-- Connected apps: other products (first: Kairo HR) can, with the user's consent, read a user's
-- combined busy times across all their calendars, get live updates, and add events.

create table public.api_clients (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  client_id text not null unique,
  secret_hash text not null,                 -- sha256 hex of the client secret
  webhook_url text,                          -- where busy-time updates are pushed
  webhook_secret_id uuid,                    -- vault secret used to sign pushes
  redirect_uris text[] not null default '{}',
  allowed_scopes text[] not null default array['busy.read','events.write'],
  created_at timestamptz not null default now()
);

create table public.app_connections (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.api_clients(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  external_ref text,                         -- the app's own id for this person
  scopes text[] not null,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  last_push_hash text,
  last_pushed_at timestamptz,
  last_push_error text,
  unique (client_id, user_id)
);
create index app_connections_user on public.app_connections(user_id);

create table public.app_auth_codes (
  code_hash text primary key,
  client_id uuid not null references public.api_clients(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  external_ref text,
  scopes text[] not null,
  redirect_uri text not null,
  expires_at timestamptz not null
);

create table public.app_events (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null references public.app_connections(id) on delete cascade,
  account_id uuid references public.connected_accounts(id) on delete set null,
  provider_event_id text not null,
  meeting_url text,
  created_at timestamptz not null default now()
);

-- change-notification subscriptions with Google / Microsoft (one per connected calendar)
create table public.calendar_watches (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null unique references public.connected_accounts(id) on delete cascade,
  provider text not null,
  channel_id text not null unique,           -- Google channel id / Microsoft subscription id
  resource_id text,                          -- Google resource id (needed to stop a channel)
  token text not null,                       -- shared secret echoed back on each notification
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

alter table public.api_clients enable row level security;
alter table public.app_connections enable row level security;
alter table public.app_auth_codes enable row level security;
alter table public.app_events enable row level security;
alter table public.calendar_watches enable row level security;
-- all access goes through the API (service role)

create or replace function public.read_vault_secret(p_id uuid) returns text
language sql security definer set search_path = '' as $$
  select decrypted_secret from vault.decrypted_secrets where id = p_id;
$$;
revoke all on function public.read_vault_secret(uuid) from public, anon, authenticated;

-- register Kairo HR; its client secret and webhook signing secret live in Vault
do $$
declare
  secret text := encode(extensions.gen_random_bytes(32), 'hex');
  whsec text := 'whsec_' || encode(extensions.gen_random_bytes(24), 'hex');
  secret_vault uuid;
  wh_vault uuid;
begin
  secret_vault := vault.create_secret('kr_' || secret, 'kairo_hr_client_secret', 'Kairo Link connected app: Kairo HR client secret');
  wh_vault := vault.create_secret(whsec, 'kairo_hr_webhook_secret', 'Kairo Link connected app: Kairo HR webhook signing secret');
  insert into public.api_clients (name, client_id, secret_hash, webhook_secret_id, redirect_uris)
  values ('Kairo HR', 'kairo-hr', encode(extensions.digest('kr_' || secret, 'sha256'), 'hex'), wh_vault,
          array['https://app.kairohr.co/integrations/kairo-link/callback']);
end $$;

create or replace function public.is_reserved_handle(h text) returns boolean
language sql immutable set search_path = '' as $$
  select h = any (array['app','api','b','login','signup','logout','pricing','privacy','terms','help','support',
    'about','admin','settings','manage','book','booking','public','static','assets','www','mail','blog','kairo','link',
    'invite','join','team','teams','connect','apps','hooks','oauth']);
$$;
