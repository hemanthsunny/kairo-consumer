-- 3-day trial for new accounts; WhatsApp hidden for now (SMS-only Premium)
alter table public.profiles alter column trial_ends_at set default now() + interval '3 days';
update public.app_settings set value = 'false'::jsonb where key = 'whatsapp_enabled';
update public.profiles set reminder_channels = array_remove(reminder_channels, 'whatsapp') where 'whatsapp' = any(reminder_channels);
