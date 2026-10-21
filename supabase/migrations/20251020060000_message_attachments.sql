-- Attach WhatsApp messages to a ticket (W1).
--
-- "Desde una conversación se crean/asignan tickets y se seleccionan mensajes
-- para adjuntarlos al ticket." The evidence matters: when someone disputes
-- what was said, the ticket should carry the exact messages, not a link the
-- reader has to go chase.
--
-- This is a genuine m2m, not a column on messages: one message can inform
-- several tickets, and one ticket can accumulate messages from several
-- conversations. Deleting the ticket takes its attachments with it; deleting
-- a message does NOT silently rewrite history, because an incident record
-- that loses its evidence when someone tidies a chat is worse than useless.
--
-- That asymmetry is why the FK to messages is ON DELETE RESTRICT and the one
-- to tickets is CASCADE.

create table if not exists public.ticket_message_attachments (
  ticket_id uuid not null references public.tickets(id) on delete cascade,
  message_id uuid not null references public.messages(id) on delete restrict,
  attached_by uuid not null references public.profiles(id),
  note text,
  attached_at timestamptz not null default now(),
  primary key (ticket_id, message_id)
);

comment on table public.ticket_message_attachments is
  'W1: messages selected from a conversation and attached to a ticket as evidence.';

create index if not exists ticket_message_attachments_message_idx
  on public.ticket_message_attachments(message_id);

-- The UI always asks "what is attached to this ticket?", newest first.
create index if not exists ticket_message_attachments_ticket_idx
  on public.ticket_message_attachments(ticket_id, attached_at desc);

analyze public.ticket_message_attachments;