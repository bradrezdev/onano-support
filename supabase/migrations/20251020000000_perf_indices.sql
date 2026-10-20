-- =============================================================
-- WhatsApp CRM — Performance indices (T19)
-- Targets the hot paths called by /api/tickets, /api/conversations,
-- /api/users, and the inbox. Every index uses IF NOT EXISTS so this is
-- safe to re-apply against a DB that already has the schema.
--
-- Hot paths:
--   GET /api/tickets     → ORDER BY updated_at DESC, range pagination,
--                          optional filters on assigned_to / status /
--                          category_id / theme_id / flow_id / contact_id.
--   GET /api/conversations → ORDER BY last_message_at DESC NULLS LAST,
--                            filter on status / assigned_agent_id /
--                            contact_id.
--   GET /api/tickets/[id]  → single row by id (PK ✓) + 1:N messages
--                            and history by ticket_id.
--   GET /api/users        → joins profiles + auth.admin.listUsers.
--   GET /api/contacts     → ILIKE '%name%' (already covered by
--                           contacts_name_trgm).
-- =============================================================

-- -------------------------------------------------------------
-- Tickets — the highest-traffic list. The default sort is
-- updated_at DESC with range pagination, so we need a real index
-- there. Then a handful of composites for the most common filter
-- combinations used by the UI ("my open tickets", "by category",
-- "by agent").
-- -------------------------------------------------------------

-- Base sort index — every list endpoint orders by this.
create index if not exists tickets_updated_at_idx
  on public.tickets(updated_at desc);

-- "My open tickets" — assigned to me, not closed, newest first.
create index if not exists tickets_assigned_status_updated_idx
  on public.tickets(assigned_to, status, updated_at desc)
  where assigned_to is not null;

-- "Tickets by category" — used by Pipeline + Categories views.
create index if not exists tickets_category_status_updated_idx
  on public.tickets(category_id, status, updated_at desc);

-- "Tickets by flow" — drag-and-drop on the pipeline.
create index if not exists tickets_flow_updated_idx
  on public.tickets(flow_id, updated_at desc)
  where flow_id is not null;

-- "Tickets by theme" — pipeline row group.
create index if not exists tickets_theme_updated_idx
  on public.tickets(theme_id, updated_at desc)
  where theme_id is not null;

-- "Tickets I created" — the agent's own tickets dashboard.
create index if not exists tickets_created_by_updated_idx
  on public.tickets(created_by, updated_at desc);

-- "Open tickets globally" — the default inbox filter; used by /
-- api/tickets when no status filter is supplied but the user is in
-- "open" state by convention.
create index if not exists tickets_open_updated_idx
  on public.tickets(updated_at desc)
  where status in ('open', 'in_progress');

-- -------------------------------------------------------------
-- Conversations — inbox list. The default sort is
-- last_message_at DESC NULLS LAST with optional status/contact/agent
-- filters.
-- -------------------------------------------------------------

-- "Open conversations, newest activity first" — the inbox query.
create index if not exists conversations_status_last_message_idx
  on public.conversations(status, last_message_at desc nulls last);

-- "Conversations assigned to me" — soporte dashboard.
create index if not exists conversations_agent_last_message_idx
  on public.conversations(assigned_agent_id, last_message_at desc nulls last)
  where assigned_agent_id is not null;

-- "Conversations for a contact" — used when opening a contact.
create index if not exists conversations_contact_last_message_idx
  on public.conversations(contact_id, last_message_at desc nulls last);

-- -------------------------------------------------------------
-- messages — the second-hot table by row count. Status callback
-- looks up by twilio_sid (already uniquely indexed ✓), but the
-- inbox uses "last message" patterns + conversation thread load.
-- We already have (conversation_id, created_at desc) — keep it.
-- Add partial on direction so direction='in' filters are fast.
-- -------------------------------------------------------------
create index if not exists messages_inbound_idx
  on public.messages(conversation_id, created_at desc)
  where direction = 'in';

-- -------------------------------------------------------------
-- ticket_messages — bubble thread. Already covers ticket_id+time.
-- Add (ticket_id, role_at_send) for the fade_step auto-increment
-- calculation (last message by this role).
-- -------------------------------------------------------------
create index if not exists ticket_messages_ticket_role_idx
  on public.ticket_messages(ticket_id, role_at_send, created_at desc);

-- -------------------------------------------------------------
-- ticket_history — appended on every mutation. Already covers
-- ticket_id+time. Add actor_id for "what did this agent do" audit.
-- -------------------------------------------------------------
create index if not exists ticket_history_actor_created_idx
  on public.ticket_history(actor_id, created_at desc);

-- -------------------------------------------------------------
-- profiles — auth lookup happens on every API request via
-- getCurrentUser (reads profile by id, PK ✓). The admin manage
-- RLS policy does exists(... role = 'admin') — covered by
-- profiles_role_idx. Add a partial index that excludes suspended
-- and deleted rows for the hot read path.
-- -------------------------------------------------------------
create index if not exists profiles_active_id_idx
  on public.profiles(id)
  where suspended_at is null and deleted_at is null;

-- -------------------------------------------------------------
-- ANALYZE so the planner has fresh statistics after the new
-- indices exist.
-- -------------------------------------------------------------
analyze public.tickets;
analyze public.conversations;
analyze public.messages;
analyze public.ticket_messages;
analyze public.ticket_history;
analyze public.profiles;
