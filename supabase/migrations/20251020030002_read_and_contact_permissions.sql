-- Add the read/CRUD permissions that the remaining routes need.
--
-- These were missing from the first catalogue: ticket.read and the four
-- contact keys. Without them the routes would either keep hardcoding roles
-- (which defeats R2/R3) or be gated behind an unrelated key.
--
-- "read" is a real capability, not a formality: Soporte reading every ticket
-- in the workspace is not the same as Soporte reading the ones assigned to
-- them. Splitting read from write lets an Admin grant sight without power.

insert into public.permissions (key, label, group_name)
values
  ('ticket.read',      'Ver tickets',         'Tickets'),
  ('contact.read',     'Ver clientes',        'Clientes'),
  ('contact.create',   'Crear clientes',      'Clientes'),
  ('contact.update',   'Editar clientes',     'Clientes'),
  ('contact.delete',   'Eliminar clientes',   'Clientes')
on conflict (key) do nothing;

-- admin takes everything by construction, so future keys stay admin-only
-- until someone grants them deliberately.
insert into public.role_permissions (role_id, permission_key)
select r.id, p.key
from public.roles r
cross join public.permissions p
where r.key = 'admin'
on conflict do nothing;

-- Supervisor operates the team: reads and edits tickets and clients, and
-- deletes clients (C1 allows alta/edición; baja is a Supervisor call too).
insert into public.role_permissions (role_id, permission_key)
select r.id, p.key
from public.roles r
cross join public.permissions p
where r.key = 'supervisor'
  and p.key in (
    'ticket.read',
    'contact.read', 'contact.create', 'contact.update', 'contact.delete'
  )
on conflict do nothing;

-- Soporte reads and creates clients (C1: alta by the three roles), but never
-- deletes one — removing a record is not an intake action.
insert into public.role_permissions (role_id, permission_key)
select r.id, p.key
from public.roles r
cross join public.permissions p
where r.key = 'soporte'
  and p.key in ('ticket.read', 'contact.read', 'contact.create')
on conflict do nothing;

analyze public.permissions;
analyze public.role_permissions;