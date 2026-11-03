-- New accounts: email 30 min, WhatsApp 10 min, SMS 30 min before booked meetings.
-- WhatsApp/SMS only send once the user is on Premium and has added a mobile number.
alter table public.profiles alter column reminder_prefs
  set default '{"scope":"bookings","email":[30],"whatsapp":[10],"sms":[30]}'::jsonb;
