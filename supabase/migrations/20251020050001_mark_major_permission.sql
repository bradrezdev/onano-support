-- Marking a ticket as a major incident feeds the client ficha's escalation
-- summary (C2), so it is a triage judgement with its own gate — not a
-- generic edit. Supervisor and above hold it; Soporte cannot inflate the
-- escalation record.

insert into public.permissions (key, label, group_name)
values ('ticket.markMajor', 'Marcar ticket como incidencia mayor', 'Tickets')
on conflict (key) do nothing;

insert into public.role_permissions (role_id, permission_key)
select r.id, p.key
from public.roles r
cross join public.permissions p
where r.key in ('admin', 'supervisor') and p.key = 'ticket.markMajor'
on conflict do nothing;

analyze public.permissions;
