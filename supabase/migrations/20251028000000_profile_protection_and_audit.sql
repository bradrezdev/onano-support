-- E1 · Cierre de la autoedición de privilegios (perfiles + catálogo)
--
-- Contexto (auditoría `audit/message-flow`):
--   La política "profiles self update" era `WITH CHECK (auth.uid() = id)`:
--   restringía FILA, no COLUMNAS. Concedía a todo usuario autenticado el
--   UPDATE de su propia fila de `profiles` — incluidas `role_key` y `role`.
--   `resolve_permissions` resuelve `coalesce(role_key, role)`, así que
--   autoasignarse `role_key = 'admin'` devolvía el keyring completo de admin
--   en `/api/me`. La escalada estaba confirmada por declaración.
--
-- Este migration cierra el hueco en tres capas:
--
--   1. CONTENCIÓN DE CREDENCIALES. Las columnas `twilio_*` salen de
--      `profiles`. Ningún código las leía (0 hits en `apps/**`) y la política
--      de lectura `using (true)` las exponía a cualquier autenticado. Solo
--      se documentan metadatos: el valor de un token real, si existió, se
--      rota por fuera (la rotación es del operador, no del esquema).
--
--   2. PERMISOS EFECTIVOS. `anon` y `authenticated` pierden TODO privilegio
--      sobre las tablas de `public`: la app habla con la base únicamente con
--      el cliente `service_role` (bypassa RLS) y el SPA usa la clave
--      publicable SOLO para Auth. Con esa premisa, el acceso directo a los
--      datos por REST deja de existir y la política de autoedición deja de
--      tener en qué apoyarse. Los `default privileges` se corrigen también
--      para que las tablas futuras nazcan cerradas por defecto.
--
--   3. BITÁCORA ADMINISTRATIVA. `admin_audit_log` (append-only) registra rol,
--      suspensión, nombre y permisos, y el cambio y su rastro viajan en la
--      MISMA transacción (funciones `security definer` de la sección 4). Sin
--      eso, un cambio de rol y su registro son dos llamadas: si la segunda
--      falla, el rol queda cambiado y sin rastro.
--
-- Lo que cada actor puede editar, y por qué vía (S10):
--
--   · Agente / Supervisor → `display_name`, `phone`. Vía `PATCH /api/me`,
--     cuyo cuerpo es el allowlist completo (`z.strictObject`): cualquier otra
--     clave se rechaza en vez de ignorarse en silencio.
--   · Administrador con `admin.assignRole` → `role_key`, `suspension`,
--     `display_name`. Vía `PATCH /api/users/[id]`, que llama a
--     `admin_update_profile` (transaccional y auditado).
--   · Administrador con `admin.manageRoles` → permisos de un rol. Vía
--     `PATCH /api/roles/[id]`, que llama a `admin_replace_role_permissions`.
--   · Nadie edita el perfil por SQL desde el navegador: los privilegios de
--     escritura de `anon`/`authenticated` quedan revocados.

-- ---------------------------------------------------------------------------
-- 1 · Contención de credenciales almacenadas
-- ---------------------------------------------------------------------------
alter table public.profiles
  drop column if exists twilio_account_sid,
  drop column if exists twilio_auth_token,
  drop column if exists twilio_whatsapp_number;

comment on table public.profiles is
  'Perfil del usuario. role_key es la fuente de verdad del rol; role es legacy. '
  'Las escrituras solo ocurren por la API (service_role) mediante funciones transaccionales.';

-- ---------------------------------------------------------------------------
-- 2 · Permisos efectivos: `anon` y `authenticated` sin acceso directo
-- ---------------------------------------------------------------------------
-- La app no usa la clave publicable para datos: el SPA solo conserva la
-- sesión de Auth y todo lo demás pasa por la API con `service_role`.
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all routines in schema public from anon, authenticated;

-- Y las tablas que nazcan después, cerradas por defecto. Sin esto, cada
-- `create table` futuro heredaría de nuevo los permisos abiertos de Supabase.
alter default privileges in schema public
  revoke all on tables from anon, authenticated;
alter default privileges in schema public
  revoke all on sequences from anon, authenticated;
alter default privileges in schema public
  revoke all on routines from anon, authenticated;

-- `resolve_permissions` era `security definer` y ejecutable por `authenticated`:
-- cualquier usuario podía pedir el keyring de CUALQUIER `p_profile_id`. Ya no
-- hace falta desde el navegador: la API lo llama con `service_role`.
revoke execute on function public.resolve_permissions(uuid) from anon, authenticated;

-- Las políticas de `profiles` quedan sin efecto (el privilegio ya no existe).
-- Se retiran para que lo declarado no sugiera un acceso que ya no está.
drop policy if exists "profiles authed read" on public.profiles;
drop policy if exists "profiles self update" on public.profiles;
drop policy if exists "profiles admin manage" on public.profiles;

-- ---------------------------------------------------------------------------
-- 3 · Bitácora append-only de acciones administrativas
-- ---------------------------------------------------------------------------
-- Es distinta de `ticket_history` (movimientos de tickets y conversaciones) y
-- de `GET /api/audit`, que sirve esa otra bitácora. Esta registra lo que un
-- administrador le hizo a un perfil o a un rol.
create table if not exists public.admin_audit_log (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references public.profiles(id) on delete set null,
  action text not null,
  resource_type text not null,
  resource_id uuid,
  before jsonb,
  after jsonb,
  created_at timestamptz not null default now()
);

create index if not exists admin_audit_log_resource_idx
  on public.admin_audit_log (resource_type, created_at desc);
create index if not exists admin_audit_log_actor_idx
  on public.admin_audit_log (actor_id, created_at desc);

alter table public.admin_audit_log enable row level security;

-- Append-only también para la API: el servicio solo inserta y consulta.
-- No hay política de UPDATE/DELETE, así que RLS las deniega.
revoke update, delete, truncate on public.admin_audit_log from service_role;
grant select, insert on public.admin_audit_log to service_role;

comment on table public.admin_audit_log is
  'Bitácora append-only de acciones administrativas (actor, acción, recurso, antes/después). '
  'El cambio y su registro se escriben en la misma transacción (admin_update_profile, '
  'admin_replace_role_permissions). No es legible directamente desde el navegador.';

-- ---------------------------------------------------------------------------
-- 4 · Escritura atómica: cambio + bitácora en la misma transacción
-- ---------------------------------------------------------------------------
create or replace function public.admin_update_profile(
  p_profile_id uuid,
  p_role_key text default null,
  p_suspend boolean default null,
  p_display_name text default null,
  p_actor uuid default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_before jsonb;
  v_after jsonb;
begin
  select jsonb_build_object(
           'role_key', role_key,
           'role', role,
           'suspended_at', suspended_at,
           'display_name', display_name
         )
    into v_before
    from public.profiles
   where id = p_profile_id
     for update;

  if v_before is null then
    raise exception 'profile_not_found: %', p_profile_id;
  end if;

  update public.profiles
     set role_key = coalesce(p_role_key, role_key),
         -- La columna legacy es CHECK (admin|supervisor|soporte): un rol
         -- personalizado no tiene valor que pase el check, así que solo se
         -- replica cuando la llave es una de las tres del sistema.
         role = case
                  when p_role_key is not null
                   and p_role_key in ('admin', 'supervisor', 'soporte')
                  then p_role_key
                  else role
                end,
         suspended_at = case
                          when p_suspend is true then now()
                          when p_suspend is false then null
                          else suspended_at
                        end,
         suspended_by = case
                          when p_suspend is true then p_actor
                          when p_suspend is false then null
                          else suspended_by
                        end,
         display_name = coalesce(p_display_name, display_name)
   where id = p_profile_id;

  select jsonb_build_object(
           'role_key', role_key,
           'role', role,
           'suspended_at', suspended_at,
           'display_name', display_name
         )
    into v_after
    from public.profiles
   where id = p_profile_id;

  insert into public.admin_audit_log (actor_id, action, resource_type, resource_id, before, after)
  values (p_actor, 'user.profile_updated', 'user', p_profile_id, v_before, v_after);
end;
$$;

comment on function public.admin_update_profile(uuid, text, boolean, text, uuid) is
  'Cambio administrativo de perfil (rol, suspensión, nombre) con bitácora en la misma transacción.';

-- Mismo motivo para el catálogo de permisos de un rol.
create or replace function public.admin_replace_role_permissions(
  p_role_id uuid,
  p_permission_keys text[],
  p_actor uuid default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_before jsonb;
begin
  select coalesce(jsonb_agg(rp.permission_key order by rp.permission_key), '[]'::jsonb)
    into v_before
    from public.role_permissions rp
   where rp.role_id = p_role_id;

  delete from public.role_permissions where role_id = p_role_id;

  if p_permission_keys is not null and cardinality(p_permission_keys) > 0 then
    insert into public.role_permissions (role_id, permission_key, granted_by)
    select p_role_id, k, p_actor
      from unnest(p_permission_keys) as k
     on conflict do nothing;
  end if;

  insert into public.admin_audit_log (actor_id, action, resource_type, resource_id, before, after)
  values (
    p_actor,
    'role.permissions_changed',
    'role',
    p_role_id,
    jsonb_build_object('permissions', v_before),
    jsonb_build_object('permissions', coalesce(p_permission_keys, '{}'::text[]))
  );
end;
$$;

comment on function public.admin_replace_role_permissions(uuid, text[], uuid) is
  'Reemplazo de permisos de un rol con bitácora en la misma transacción.';

-- Solo el backend usa estas funciones: el navegador no las ejecuta.
revoke all on function public.admin_update_profile(uuid, text, boolean, text, uuid) from public, anon, authenticated;
revoke all on function public.admin_replace_role_permissions(uuid, text[], uuid) from public, anon, authenticated;
grant execute on function public.admin_update_profile(uuid, text, boolean, text, uuid) to service_role;
grant execute on function public.admin_replace_role_permissions(uuid, text[], uuid) to service_role;

analyze public.admin_audit_log;
