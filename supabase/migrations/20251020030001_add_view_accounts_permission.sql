-- Add admin.viewAccounts to the catalogue and grant it to admin.
--
-- Split from admin.assignRole on purpose: "see who has an account" and
-- "decide what an account may do" are two different powers. An Admin may
-- delegate the first without handing over the second.

insert into public.permissions (key, label, group_name)
values ('admin.viewAccounts', 'Ver la lista de cuentas', 'Cuentas')
on conflict (key) do nothing;

insert into public.role_permissions (role_id, permission_key)
select r.id, 'admin.viewAccounts'
from public.roles r
where r.key = 'admin'
on conflict do nothing;

analyze public.permissions;