-- Soft delete for tickets ("papelera en vez de borrar").
--
-- A human error must not be irreversible. DELETE /api/tickets/:id now sets
-- deleted_at + deleted_by instead of removing the row, so ticket_history and
-- conversation_tickets survive and the Admin can see who trashed it.
--
-- Reads must filter `deleted_at is null`; the partial indices below keep the
-- hot list paths fast once the trash starts accumulating rows.

alter table public.tickets
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by uuid references public.profiles(id) on delete set null;

comment on column public.tickets.deleted_at is
  'Soft-delete marker. NULL = live. Reads must filter this column.';
comment on column public.tickets.deleted_by is
  'Admin who trashed the ticket. Kept for the audit trail.';

-- 'deleted' is not a ticket_status value on purpose: the trash is a separate
-- axis from open/in_progress/closed, so a trashed ticket still shows its last
-- real status when an Admin inspects the record.

create index if not exists tickets_live_updated_idx
  on public.tickets(updated_at desc)
  where deleted_at is null;

create index if not exists tickets_trashed_idx
  on public.tickets(deleted_at desc)
  where deleted_at is not null;

-- ticket_history.action had a check constraint that predates the trash.
-- 'trashed' and 'restored' are needed so the audit trail records who hid a
-- ticket and who brought it back.
alter table public.ticket_history
  drop constraint if exists ticket_history_action_check;

alter table public.ticket_history
  add constraint ticket_history_action_check
  check (action in
    ('created', 'assigned', 'reassigned', 'category_changed',
     'theme_changed', 'flow_changed', 'status_changed', 'closed', 'reopened',
     'trashed', 'restored'));

analyze public.tickets;