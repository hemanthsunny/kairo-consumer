-- Free plan for everyone ("basic" = Free); Premium is the only paid plan
alter table public.profiles alter column plan set default 'basic';
update public.profiles set plan = 'basic' where plan in ('trial', 'inactive');
