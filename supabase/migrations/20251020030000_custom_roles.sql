-- Custom roles with per-action permissions (R2 + recommendation 1).
--
-- Today roles are hardcoded in three places at once: a Postgres check
-- constraint, the TypeScript union 'admin' | 'supervisor' | 'soporte', and a
-- permission matrix in apps/web/src/lib/permissions.ts. An Admin cannot make
-- a new role because the database refuses to store it.
--
-- The fix is the "keyring" model: permissions are individual keys, and a role
-- is just a named bundle of them. An Admin who creates a role with no keys
-- gets an empty keyring — visibly empty, so the problem is obvious instead of
-- showing up later as mysterious 403s.
--
-- `profiles.role_key` is a slug, not a uuid FK. That is deliberate: creating
-- a role must not require a schema migration or break an existing profile,
-- and a dangling slug is safer than a dangling foreign key when a role is
-- deleted (we block that instead, see the trigger below).

-- =====================================================
-- PART 1 — permissions catalogue
-- =====================================================

create table if not exists public.permissions (
  key text primary key,
  label text not null,
  group_name text not null,
  -- System permissions ship with the app; they are never deleted, only
  -- granted or revoked. Keeps a typo from silently removing a capability.
  is_system boolean not null default true,
  created_at timestamptz not null default now()
);

comment on table public.permissions is
  'Catalogue of individual capabilities ("llaves"). Roles are bundles of these.';
comment on column public.permissions.key is
  'Stable dotted identifier, e.g. ticket.reopen. Never reuse a key with a different meaning.';

-- =====================================================
-- PART 2 — roles
-- =====================================================

create table if not exists public.roles (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  name text not null,
  description text,
  color text not null default '#64748b',
  -- The three shipped roles cannot be deleted or renamed, because profiles
  -- and role_color_settings already point at them by key.
  is_system boolean not null default false,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

comment on table public.roles is
  'Named bundles of permissions. The three system roles are seeded here; Admins can add more.';
comment on column public.roles.key is
  'Slug stored in profiles.role_key and referenced by role_color_settings.role.';

create index if not exists roles_is_system_idx on public.roles(is_system);

create table if not exists public.role_permissions (
  role_id uuid not null references public.roles(id) on delete cascade,
  permission_key text not null references public.permissions(key) on delete cascade,
  granted_at timestamptz not null default now(),
  granted_by uuid references public.profiles(id) on delete set null,
  primary key (role_id, permission_key)
);

comment on table public.role_permissions is
  'The keyring: which role holds which key.';

create index if not exists role_permissions_role_idx on public.role_permissions(role_id);
create index if not exists role_permissions_key_idx on public.role_permissions(permission_key);

-- =====================================================
-- PART 3 — profiles point at a role key
-- =====================================================

alter table public.profiles
  add column if not exists role_key text;

comment on column public.profiles.role_key is
  'Slug of the role in public.roles. NULL falls back to the legacy role column.';

update public.profiles
set role_key = role
where role_key is null;

create index if not exists profiles_role_key_idx on public.profiles(role_key);

-- The legacy check constraint stays for now: `role` remains the fallback and
-- the three shipped slugs. Removing it is a separate, reversible step once
-- every reader has moved to role_key.

-- A system role can never be deleted: profiles would be left pointing at a
-- slug with no permissions, and the failure would be silent.
create or replace function public.protect_system_role()
returns trigger
language plpgsql
as $$
begin
  if old.is_system then
    raise exception 'System role "%" cannot be deleted', old.key
      using errcode = 'restrict_violation';
  end if;
  return old;
end;
$$;

drop trigger if exists roles_protect_system on public.roles;
create trigger roles_protect_system
  before delete on public.roles
  for each row execute function public.protect_system_role();

-- Renaming a system role's key would orphan every profile that uses it.
create or replace function public.protect_system_role_key()
returns trigger
language plpgsql
as $$
begin
  if old.is_system and new.key is distinct from old.key then
    raise exception 'System role key cannot change (%" -> %)', old.key, new.key
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists roles_protect_key on public.roles;
create trigger roles_protect_key
  before update on public.roles
  for each row execute function public.protect_system_role_key();

-- =====================================================
-- PART 4 — seed the shipped roles and their keyrings
-- =====================================================

insert into public.permissions (key, label, group_name)
values
  -- Cuentas
  ('admin.createUser',    'Crear usuarios',        'Cuentas'),
  ('admin.suspendUser',   'Suspender usuarios',    'Cuentas'),
  ('admin.deleteUser',    'Desactivar usuarios',   'Cuentas'),
  ('admin.assignRole',    'Asignar roles',         'Cuentas'),
  ('admin.manageRoles',   'Administrar roles',     'Cuentas'),
  ('admin.viewAudit',     'Ver auditoría',         'Cuentas'),
  -- Categorías
  ('category.create',     'Crear categorías',      'Categorías'),
  ('category.update',     'Editar categorías',     'Categorías'),
  ('category.delete',     'Eliminar categorías',   'Categorías'),
  ('subcategory.create',  'Crear subcategorías',   'Categorías'),
  ('subcategory.delete',  'Eliminar subcategorías','Categorías'),
  -- Proyectos y pipeline
  ('theme.create',        'Crear proyectos',       'Proyectos'),
  ('theme.delete',        'Eliminar proyectos',    'Proyectos'),
  ('flow.create',         'Crear fases',           'Proyectos'),
  ('flow.delete',         'Eliminar fases',        'Proyectos'),
  -- Tickets
  ('ticket.create',       'Crear tickets',         'Tickets'),
  ('ticket.assign',       'Asignar tickets',       'Tickets'),
  ('ticket.close',        'Cerrar tickets',        'Tickets'),
  ('ticket.reopen',       'Reabrir tickets',       'Tickets'),
  ('ticket.moveFlow',     'Mover en el pipeline',  'Tickets'),
  ('ticket.reply',        'Responder tickets',     'Tickets'),
  ('ticket.delete',       'Eliminar tickets',      'Tickets'),
  -- Conversaciones
  ('conversation.read',      'Leer conversaciones',      'Conversaciones'),
  ('conversation.assign',    'Responder conversaciones',  'Conversaciones'),
  ('conversation.reassign',  'Reasignar conversaciones', 'Conversaciones'),
  ('conversation.escalate',  'Pedir apoyo',              'Conversaciones')
on conflict (key) do nothing;

insert into public.roles (key, name, description, color, is_system)
values
  ('admin',     'Admin',      'Acceso total, incluida la auditoría y la gestión de roles.', '#1e3a8a', true),
  ('supervisor', 'Supervisor', 'Opera el equipo: asigna, reabre y reasigna.',                       '#7c3aed', true),
  ('soporte',   'Soporte',    'Atiende lo que toma: responde tickets y conversaciones.',           '#16a34a', true)
on conflict (key) do nothing;

-- admin holds every key. Built from the catalogue so a newly added
-- permission is admin-only until someone grants it deliberately.
insert into public.role_permissions (role_id, permission_key)
select r.id, p.key
from public.roles r
cross join public.permissions p
where r.key = 'admin'
on conflict do nothing;

-- supervisor mirrors the historical matrix exactly, plus audit-free access.
insert into public.role_permissions (role_id, permission_key)
select r.id, p.key
from public.roles r
cross join public.permissions p
where r.key = 'supervisor'
  and p.key in (
    'category.create', 'category.update', 'subcategory.create',
    'theme.create', 'flow.create',
    'ticket.create', 'ticket.assign', 'ticket.close', 'ticket.reopen',
    'ticket.moveFlow', 'ticket.reply',
    'conversation.read', 'conversation.assign', 'conversation.reassign'
  )
on conflict do nothing;

-- soporte: attend what it takes. No reassign, no close/reopen, no delete.
insert into public.role_permissions (role_id, permission_key)
select r.id, p.key
from public.roles r
cross join public.permissions p
where r.key = 'soporte'
  and p.key in (
    'ticket.create', 'ticket.reply',
    'conversation.read', 'conversation.assign', 'conversation.escalate'
  )
on conflict do nothing;

-- =====================================================
-- PART 5 — resolver used by the API
-- =====================================================

-- Returns the permission keys a profile holds. Used by the API to resolve
-- AuthedUser.permissions in one round trip instead of N queries.
--
-- A profile with no role_key falls back to its legacy role column, and a
-- profile with no matching role gets an empty keyring — visible and
-- debuggable, never a silent admin.
create or replace function public.resolve_permissions(p_profile_id uuid)
returns text[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(array_agg(rp.permission_key), '{}'::text[])
  from public.profiles p
  left join public.role_permissions rp
    on rp.role_id = (select r.id from public.roles r where r.key = coalesce(p.role_key, p.role))
  where p.id = p_profile_id
  group by p.id;
$$;

comment on function public.resolve_permissions(uuid) is
  'Permission keys held by a profile. Empty array when the role is unknown.';

grant execute on function public.resolve_permissions(uuid) to authenticated, service_role;

analyze public.permissions;
analyze public.roles;
analyze public.role_permissions;