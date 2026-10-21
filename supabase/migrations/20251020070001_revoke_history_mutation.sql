-- The real lock on the audit trail (recommendation 4, second pass).
--
-- The previous migration added RLS policies expecting them to be the lock.
-- Verifying against the live database showed they were NOT: `authenticated`
-- has no table grant at all (so RLS never even runs), and `service_role` —
-- the key the whole API talks to Postgres with — carries BYPASSRLS, so a
-- policy aimed at it is decorative. The only thing actually preventing a
-- tampered audit row was the application code happening not to do it.
--
-- This is the lock that holds. The application only ever INSERTs into
-- ticket_history (verified: seven call sites, all `.insert()`), so removing
-- UPDATE / DELETE / TRUNCATE costs nothing and removes the ability to
-- rewrite history at the SQL layer — including for the superuser service
-- client, which is exactly the case a black box has to survive.
--
-- A legitimate repair (a GDPR erasure, a mistaken row from a bad deploy)
-- still works, but only through scripts/db.ts as the Postgres superuser, in
-- a reviewed migration. Deliberate, versioned, visible. Not an app-side
-- "fix the typo" button.

revoke update, delete, truncate on public.ticket_history from service_role;

-- Restate the grants the API actually needs, so the intent is explicit rather
-- than inherited from whatever the initial migration happened to grant.
grant select, insert on public.ticket_history to service_role;

comment on table public.ticket_history is
  'Append-only audit trail (recommendation 4). UPDATE/DELETE/TRUNCATE are revoked from '
  'service_role, so no application code path can rewrite history even with the superuser '
  'service key. Corrections happen only through a reviewed SQL migration as the Postgres '
  'superuser. See ticket_history_is_append_only() for the RLS-side assertion.';

-- Assertion: the mutation privileges must stay revoked. If a future migration
-- helpfully re-grants them, this returns false and the check is visible.
create or replace function public.ticket_history_is_append_only()
returns boolean
language sql
stable
as $$
  select
    not exists (
      select 1 from pg_policies
      where schemaname = 'public'
        and tablename = 'ticket_history'
        and cmd in ('UPDATE', 'DELETE')
    )
    and not has_table_privilege(
      'service_role', 'public.ticket_history', 'UPDATE,DELETE,TRUNCATE'
    );
$$;

comment on function public.ticket_history_is_append_only() is
  'True when ticket_history cannot be rewritten: no UPDATE/DELETE RLS policy AND no '
  'mutation privilege for service_role. This is the assertion that matters — the policy '
  'alone does not protect a role with BYPASSRLS.';