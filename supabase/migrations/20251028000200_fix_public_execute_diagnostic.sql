-- E1 (ter) · El diagnóstico de funciones ejecutables por PUBLIC, corregido
--
-- El error: `app_functions_executable_by_public()` usaba
-- `coalesce(p.proacl::text, '')` y buscaba una entrada `=X/...`. Con
-- `proacl IS NULL` (una función que conserva los privilegios POR DEFECTO de
-- PostgreSQL) el resultado era una lista VACÍA y el diagnóstico decía que
-- no había ninguna función ejecutable por PUBLIC.
--
-- Es justo el caso más peligroso: en PostgreSQL, `proacl IS NULL` significa
-- "esta función tiene EXECUTE para PUBLIC" (el privilegio por defecto), y
-- `proacl = '{}'` significa "sin privilegios". Tratar ambos como "vacío"
-- esconde el hueco.
--
-- El criterio correcto es:
--   · `proacl IS NULL`  → privilegios por defecto → PUBLIC puede ejecutar.
--   · `proacl` contiene una entrada que empieza por `=X/` → PUBLIC tiene
--     EXECUTE explícito.
--
-- Un `like '%=X/%'` NO sirve: también encuentra `postgres=X/postgres`.

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
     and (
       p.proacl is null
       or exists (
         select 1
           from unnest(string_to_array(p.proacl::text, ',')) as item
          where item ~ '(^|[{,])=X/'
       )
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
  'Funciones propias de la app que PUBLIC puede ejecutar. Debe devolver vacío. '
  'Una función con proacl NULL conserva los privilegios POR DEFECTO de PostgreSQL '
  '(EXECUTE para PUBLIC): una lista de privilegios nula no significa lo mismo que una vacía.';
