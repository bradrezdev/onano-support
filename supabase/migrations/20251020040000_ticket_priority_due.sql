-- Priority and due date (recommendation 10, D1 "Mi bandeja").
--
-- "Lo urgente no se mezcla con lo normal y nada se olvida." Two columns do
-- that job:
--
--   priority — a small enum, so filtering stays indexable and there is no
--              free text to typo. low is the default and is the majority.
--   due_at   — nullable. Absence is NOT lateness: a ticket with no deadline
--              can never be overdue, which keeps the "vencido" bucket honest
--              instead of flagging every ticket that nobody dated.
--
-- The dashboard's overdue bucket filters `due_at < now() AND due_at IS NOT
-- NULL`, served by tickets_due_open_idx below.

-- Postgres has no `create type if not exists`; the DO block is the idiomatic
-- guard so re-running this migration on a partially-applied DB is safe.
do $$
begin
  create type public.ticket_priority as enum ('low', 'normal', 'high', 'urgent');
exception
  when duplicate_object then null;
end
$$;

alter table public.tickets
  add column if not exists priority public.ticket_priority not null default 'normal',
  add column if not exists due_at timestamptz;

comment on column public.tickets.priority is
  'Urgency. Defaults to normal. Drives ordering and the "urgente" filter.';
comment on column public.tickets.due_at is
  'Deadline. NULL means no deadline — never counted as overdue.';

-- Partial index for the overdue query: only open tickets with a deadline can
-- ever be late, so the index only holds those rows.
create index if not exists tickets_due_open_idx
  on public.tickets(due_at)
  where due_at is not null and deleted_at is null and status <> 'closed';

-- "Lo urgente no se mezcla con lo normal": ordering by priority then due date
-- within an agent's queue.
create index if not exists tickets_assigned_priority_idx
  on public.tickets(assigned_to, priority desc, due_at asc nulls last)
  where deleted_at is null and status <> 'closed';

analyze public.tickets;