-- Conversation ownership workflow: take, reassign, escalate.
--
-- W3/W4 need somewhere to record who asked for help and who was asked.
-- `assigned_agent_id` alone cannot express "soporte asked supervisor to take
-- over" — that is a request, not a handover, and the asker keeps ownership.
--
-- The trash-side columns (tickets.deleted_at/deleted_by) live in the previous
-- migration; this file stays focused on conversations.

alter table public.conversations
  add column if not exists escalated_to_id uuid references public.profiles(id) on delete set null,
  add column if not exists escalated_by_id uuid references public.profiles(id) on delete set null,
  add column if not exists escalated_at timestamptz;

comment on column public.conversations.escalated_to_id is
  'W3: user asked to answer. Null = nobody asked. Does not transfer ownership.';
comment on column public.conversations.escalated_by_id is
  'W3: who raised the ask.';
comment on column public.conversations.escalated_at is
  'W3: when the ask was raised.';

-- The unassigned queue ("la fila de la caja del súper") is scanned constantly,
-- so it gets its own partial index instead of filtering the whole table.
create index if not exists conversations_unassigned_idx
  on public.conversations(last_message_at desc nulls last)
  where assigned_agent_id is null;

create index if not exists conversations_escalated_idx
  on public.conversations(escalated_at desc)
  where escalated_to_id is not null;

analyze public.conversations;