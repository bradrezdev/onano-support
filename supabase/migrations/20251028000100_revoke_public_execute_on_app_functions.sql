-- E1 (bis) · EXECUTE por defecto de PUBLIC en las funciones de la app
--
-- En Postgres una función NACE con EXECUTE para el rol PUBLIC. La migración
-- de E1 le quitó el privilegio a `anon` y `authenticated`, pero revocar roles
-- concretos NO quita ese permiso por defecto: la entrada `=X/<grantor>` en
-- `pg_proc.proacl` sobrevive.
--
-- `resolve_permissions` es SECURITY DEFINER y resuelve el keyring de
-- CUALQUIER `p_profile_id`. Con PUBLIC ejecutándola, cualquier rol —incluso
-- `anon`, sin sesión— podía pedir el keyring de cualquier perfil.
--
-- La comprobación correcta del permiso efectivo es `pg_proc.proacl`: un
-- elemento que empieza por `=X/` es exactamente "PUBLIC tiene EXECUTE".
-- Buscar `like '%=X/%'` NO sirve: también encuentra `postgres=X/postgres`.
--
-- Solo se tocan las funciones PROPIAS de la app. Las de la extensión pg_trgm
-- (similarity, word_similarity…) también viven en `public` en esta base y
-- quitarle EXECUTE a PUBLIC rompería la búsqueda por trigramas, que el API
-- usa con `service_role`. Las funciones que pertenecen a una extensión se
-- detectan por `pg_depend.deptype = 'e'`.

do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure::text as signature
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and not exists (
         select 1 from pg_depend d
          where d.objid = p.oid and d.deptype = 'e'
       )
  loop
    execute format('revoke execute on function %s from public', r.signature);
  end loop;
end $$;

-- Lo que la API sí necesita. Las funciones de trigger no requieren permiso
-- en tiempo de ejecución (se comprueba al crear el trigger), pero se
-- conceden igual para que el estado del catálogo sea uniforme.
grant execute on function public.resolve_permissions(uuid) to service_role;
grant execute on function public.ticket_history_is_append_only() to service_role;
grant execute on function public.admin_update_profile(uuid, text, boolean, text, uuid) to service_role;
grant execute on function public.admin_replace_role_permissions(uuid, text[], uuid) to service_role;

-- Diagnóstico reutilizable: funciones propias de la app que PUBLIC todavía
-- puede ejecutar. Debe devolver vacío. Vive fuera de la base que protege:
-- el esquema se versiona en el repo, este archivo es su registro.
create or replace function public.app_functions_executable_by_public()
returns table (proname text, signature text, security_definer boolean)
language sql
stable
as $$
  select p.proname,
         p.oid::regprocedure::text,
         p.prosecdef
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and exists (
       select 1
         from unnest(string_to_array(coalesce(p.proacl::text, ''), ',')) as item
        where item ~ '(^|[{,])=X/'
     )
     and not exists (
       select 1 from pg_depend d
        where d.objid = p.oid and d.deptype = 'e'
     )
   order by p.proname;
$$;

grant execute on function public.app_functions_executable_by_public() to service_role;
revoke execute on function public.app_functions_executable_by_public() from public;

comment on function public.app_functions_executable_by_public() is
  'Funciones propias de la app que PUBLIC puede ejecutar. Debe devolver vacío: una función SECURITY DEFINER ejecutable por PUBLIC puede actuar con más privilegios de los que su rol tiene.';

comment on function public.resolve_permissions(uuid) is
  'Permission keys held by a profile. Empty array when the role is unknown. Solo service_role: SECURITY DEFINER y ejecutable por cualquiera sería una fuga.';
