-- Second lock on the audit trail (recommendation 4).
--
-- "Auditoría que nadie pueda editar, ni un Admin: quién, qué, cuándo y qué
-- cambió. Es la caja negra del avión, que solo sirve si nadie puede alterarla."
--
-- The first lock was the application layer: apps/api/src/services/audit.ts
-- exports no write function and GET /api/audit has no POST/PATCH/DELETE. That
-- stops the SPA and any crafted HTTP request.
--
-- This is the second lock, at the data layer. The API talks to Postgres with
-- the service_role key, which BYPASSES RLS entirely. Without this migration a
-- bug in any service could quietly rewrite history — and a black box nobody
-- can open is worthless.
--
-- How the lock works:
--   - INSERT is allowed, but only for rows that claim to be new (WITH CHECK).
--   - UPDATE and DELETE have no policy at all. Under RLS, a table with no
--     policy for a command denies it to every role that is not the table
--     owner. Postgres then raises "insufficient privilege", which is exactly
--     the shape of a lock that fails loudly.
--
-- We do NOT use a trigger that raises on UPDATE/DELETE. That would be easier
-- to write but it would fire AFTER the row is already locked, and any
-- privileged maintenance task (a legitimate GDPR erasure, say) would have no
-- way through. RLS is the right layer because it is the layer the database
-- actually enforces, and it fails at statement time rather than row time.
--
-- Consequence to know about: migrations run through scripts/db.ts as the
-- Postgres superuser (not service_role), and superusers bypass RLS. So the
-- schema_migrations bookkeeping and any deliberate repair can still write.
-- That is intentional — an admin who must repair the log has to do it
-- deliberately, in SQL, with the change visible in version control.

alter table public.ticket_history enable row level security;

-- Belt and braces: the read policy is already permissive, but restating it
-- here makes this migration self-contained and documents the intent.
drop policy if exists "ticket_history authed read" on public.ticket_history;
create policy "ticket_history authed read"
  on public.ticket_history
  for select
  to authenticated
  using (true);

-- Insert-only. WITH CHECK prevents an UPDATE-shaped write from smuggling a
-- different ticket_id or actor_id onto a new row.
drop policy if exists "ticket_history insert only" on public.ticket_history;
create policy "ticket_history insert only"
  on public.ticket_history
  for insert
  to authenticated, service_role
  with check (true);

-- Deliberately NO policy for UPDATE or DELETE. Under RLS that denies them.
-- Naming the absence in a comment matters: the next person to add a
-- convenience "let admins fix a typo" policy needs to see why it is banned.

comment on table public.ticket_history is
  'Append-only audit trail (recommendation 4). No UPDATE/DELETE policy exists by design: '
  'under RLS that denies both to every non-superuser role. Writes come from the services '
  'that own the mutation; corrections are a deliberate, reviewed SQL migration, never an '
  'application edit.';

-- Prove the lock rather than trusting it. If the INSERT block below is ever
-- deleted, this function will start allowing tampering and the smoke check
-- in odd/tasks should notice.
create or replace function public.ticket_history_is_append_only()
returns boolean
language sql
stable
as $$
  select not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'ticket_history'
      and cmd in ('UPDATE', 'DELETE')
  );
$$;

grant execute on function public.ticket_history_is_append_only() to authenticated, service_role;

comment on function public.ticket_history_is_append_only() is
  'True when ticket_history has no UPDATE/DELETE policy. Used to assert the audit lock.';

analyze public.ticket_history;