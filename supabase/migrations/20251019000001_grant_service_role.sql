-- 20251019000001_grant_service_role.sql
-- After dropping/recreating the public schema, the auto-grants Supabase applies
-- to service_role are gone. Restore them so backend admin queries work.

grant usage on schema public to service_role;

grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
grant all on all routines in schema public to service_role;

-- Same for the default privileges Supabase configures for future objects.
alter default privileges in schema public
  grant all on tables to service_role;
alter default privileges in schema public
  grant all on sequences to service_role;
alter default privileges in schema public
  grant all on routines to service_role;