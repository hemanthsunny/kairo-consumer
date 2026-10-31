-- Per-calendar switch: show event titles/join links in the app (fetched live, never stored)
alter table public.connected_accounts add column if not exists show_details boolean not null default true;
