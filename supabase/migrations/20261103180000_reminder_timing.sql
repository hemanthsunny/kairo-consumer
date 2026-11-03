-- Per-channel reminder timing, optional reminders for all calendar events.
-- reminder_prefs: {"scope":"bookings"|"all","email":[minutes...],"whatsapp":[...],"sms":[...]}

alter table public.profiles
  add column reminder_prefs jsonb not null
  default '{"scope":"bookings","email":[1440,30],"whatsapp":[],"sms":[]}'::jsonb
  check (jsonb_typeof(reminder_prefs) = 'object');

update public.profiles set reminder_prefs = jsonb_build_object(
  'scope', 'bookings',
  'email', case when 'email' = any(reminder_channels) then '[1440,30]'::jsonb else '[]'::jsonb end,
  'whatsapp', case when 'whatsapp' = any(reminder_channels) then '[30]'::jsonb else '[]'::jsonb end,
  'sms', case when 'sms' = any(reminder_channels) then '[30]'::jsonb else '[]'::jsonb end
);

alter table public.notification_outbox drop constraint if exists notification_outbox_kind_check;
alter table public.notification_outbox add constraint notification_outbox_kind_check
  check (kind in ('confirmation','reminder_24h','reminder_1h','reminder','event_reminder','cancellation'));
alter table public.notification_outbox add column offset_min int;
-- snapshot of a calendar event for event reminders; cleared once handled
alter table public.notification_outbox add column event jsonb;

-- host reminders are now created shortly before they are due, from current settings
update public.notification_outbox set status = 'skipped', last_error = 'Replaced by reminder settings'
where status = 'pending' and recipient = 'host' and kind in ('reminder_24h','reminder_1h');

-- short-lived list of upcoming events, only for users who turn on reminders for all events
create table public.event_cache (
  account_id uuid primary key references public.connected_accounts(id) on delete cascade,
  range_start timestamptz not null,
  range_end timestamptz not null,
  events jsonb not null default '[]'::jsonb,
  fetched_at timestamptz not null default now()
);
alter table public.event_cache enable row level security;

-- check every minute so 10-minute reminders arrive on time
select cron.alter_job((select jobid from cron.job where jobname = 'kairo-link-reminders'), schedule := '* * * * *');
