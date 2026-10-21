-- Split "edit a ticket" from "create one".
--
-- PATCH /api/tickets/:id mixes fields with different power levels: renaming
-- is not the same act as reassigning or moving in the pipeline. Requiring the
-- union would let someone who may only rename also reassign.

insert into public.permissions (key, label, group_name)
values ('ticket.update', 'Editar tickets', 'Tickets')
on conflict (key) do nothing;

insert into public.role_permissions (role_id, permission_key)
select r.id, p.key
from public.roles r
cross join public.permissions p
where r.key in ('admin', 'supervisor', 'soporte') and p.key = 'ticket.update'
on conflict do nothing;

analyze public.permissions;
