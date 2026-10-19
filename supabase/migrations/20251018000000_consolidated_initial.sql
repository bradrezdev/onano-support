-- =============================================================
-- WhatsApp CRM — Consolidated initial migration
-- Apply ONCE in the Supabase SQL Editor against a new project.
-- Replaces: 20251016000000_init.sql, 20251016000001_rls.sql,
--           20251016000002_triggers.sql, 20251016000003_storage.sql
--           plus 7 new migrations from the implementation plan.
-- =============================================================

-- =====================================================
-- PART 1: Existing schema (from 20251016000000_init.sql)
--         with role enum broadened to include supervisor and soporte.
-- =====================================================

create extension if not exists "pgcrypto";
create extension if not exists "pg_trgm";

-- Perfiles que extienden auth.users con datos del workspace.
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '',
  role text not null default 'soporte' check (role in ('admin', 'supervisor', 'soporte')),
  avatar_url text,
  twilio_account_sid text,
  twilio_auth_token text,
  twilio_whatsapp_number text,
  suspended_at timestamptz,
  deleted_at timestamptz,
  suspended_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);

create index if not exists profiles_role_idx on public.profiles(role);

-- Contactos: una fila por número de WhatsApp.
create table if not exists public.contacts (
  id uuid primary key default gen_random_uuid(),
  whatsapp_number text not null unique,
  name text,
  email text,
  country text,
  country_code text,
  profile_pic_url text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index if not exists contacts_whatsapp_number_idx on public.contacts(whatsapp_number);
create index if not exists contacts_name_trgm on public.contacts using gin (name gin_trgm_ops);
create index if not exists contacts_email_idx on public.contacts(email) where email is not null;
create index if not exists contacts_country_idx on public.contacts(country) where country is not null;
create index if not exists contacts_country_code_idx on public.contacts(country_code) where country_code is not null;
create index if not exists contacts_deleted_at_idx on public.contacts(deleted_at);

-- Conversaciones: vínculo entre un contacto y un agente asignado.
create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid not null references public.contacts(id) on delete cascade,
  assigned_agent_id uuid references public.profiles(id) on delete set null,
  status text not null default 'open' check (status in ('open', 'pending', 'closed')),
  last_message_at timestamptz,
  last_message_preview text,
  unread_count int not null default 0 check (unread_count >= 0),
  created_at timestamptz not null default now()
);

create index if not exists conversations_contact_idx on public.conversations(contact_id);
create index if not exists conversations_assigned_agent_idx on public.conversations(assigned_agent_id);
create index if not exists conversations_status_idx on public.conversations(status);
create index if not exists conversations_last_message_at_idx on public.conversations(last_message_at desc nulls last);

-- Mensajes: in (entrante) y out (saliente) con metadata de Twilio.
create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  direction text not null check (direction in ('in', 'out')),
  body text,
  media_urls jsonb not null default '[]'::jsonb,
  twilio_sid text unique,
  twilio_status text check (twilio_status in ('queued', 'sent', 'delivered', 'read', 'failed')),
  sent_by_id uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists messages_conversation_created_idx
  on public.messages(conversation_id, created_at desc);
create index if not exists messages_twilio_sid_idx on public.messages(twilio_sid);
create index if not exists messages_direction_idx on public.messages(direction);

-- Etapas del pipeline (embudo). Configurables por el admin.
create table if not exists public.pipeline_stages (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  color text default '#64748b',
  position int not null,
  is_terminal boolean not null default false,
  created_at timestamptz not null default now(),
  unique (name, position)
);

create index if not exists pipeline_stages_position_idx on public.pipeline_stages(position);

-- Posición actual de una conversación en el pipeline (histórico append-only).
create table if not exists public.conversation_stages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  stage_id uuid not null references public.pipeline_stages(id) on delete restrict,
  entered_at timestamptz not null default now(),
  entered_by_id uuid references public.profiles(id) on delete set null
);

create index if not exists conversation_stages_conversation_idx
  on public.conversation_stages(conversation_id, entered_at desc);

-- Etiquetas globales reutilizables.
create table if not exists public.tags (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  color text default '#64748b',
  created_at timestamptz not null default now()
);

-- Asociación N:M contacto ↔ tag.
create table if not exists public.contact_tags (
  contact_id uuid not null references public.contacts(id) on delete cascade,
  tag_id uuid not null references public.tags(id) on delete cascade,
  primary key (contact_id, tag_id)
);

create index if not exists contact_tags_tag_idx on public.contact_tags(tag_id);

-- Notas internas: o sobre un contacto, o sobre una conversación. Nunca ambas nulas.
create table if not exists public.notes (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid references public.contacts(id) on delete cascade,
  conversation_id uuid references public.conversations(id) on delete cascade,
  author_id uuid references public.profiles(id) on delete set null,
  body text not null,
  created_at timestamptz not null default now(),
  check (contact_id is not null or conversation_id is not null)
);

create index if not exists notes_contact_idx on public.notes(contact_id);
create index if not exists notes_conversation_idx on public.notes(conversation_id);
create index if not exists notes_author_idx on public.notes(author_id);

-- =====================================================
-- PART 2: NEW — Categories (tree with self-FK for subcategories)
-- =====================================================

create table if not exists public.categories (
  id uuid primary key default gen_random_uuid(),
  parent_id uuid references public.categories(id) on delete cascade,
  name text not null,
  description text,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint categories_name_not_empty check (length(trim(name)) > 0),
  constraint categories_no_self_parent check (parent_id is null or parent_id <> id)
);

create index if not exists categories_parent_idx on public.categories(parent_id);
create unique index if not exists uq_categories_parent_name
  on public.categories(coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name));

-- =====================================================
-- PART 3: NEW — Themes & Flows
-- =====================================================

create table if not exists public.themes (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  description text,
  color text not null default '#6366f1',
  position int not null default 0,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists themes_position_idx on public.themes(position);

create table if not exists public.flows (
  id uuid primary key default gen_random_uuid(),
  theme_id uuid not null references public.themes(id) on delete cascade,
  name text not null,
  description text,
  position int not null default 0,
  is_terminal boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (theme_id, name)
);

create index if not exists flows_theme_idx on public.flows(theme_id);
create index if not exists flows_position_idx on public.flows(position);

-- =====================================================
-- PART 4: NEW — Tickets, messages, history, conversation link, role colors
-- =====================================================

drop type if exists public.ticket_status cascade;
create type public.ticket_status as enum ('open', 'in_progress', 'closed');

create table if not exists public.tickets (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid not null references public.contacts(id) on delete restrict,
  category_id uuid not null references public.categories(id) on delete restrict,
  assigned_to uuid references public.profiles(id) on delete set null,
  theme_id uuid references public.themes(id) on delete set null,
  flow_id uuid references public.flows(id) on delete set null,
  name text not null,
  description jsonb not null,                -- TipTap document
  description_plain text not null,          -- for search/preview
  status public.ticket_status not null default 'open',
  created_by uuid not null references public.profiles(id),
  closed_by uuid references public.profiles(id),
  closed_at timestamptz,
  reopened_by uuid references public.profiles(id),
  reopened_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists tickets_assigned_idx on public.tickets(assigned_to) where assigned_to is not null;
create index if not exists tickets_status_idx on public.tickets(status);
create index if not exists tickets_contact_idx on public.tickets(contact_id);
create index if not exists tickets_category_idx on public.tickets(category_id);
create index if not exists tickets_theme_idx on public.tickets(theme_id) where theme_id is not null;
create index if not exists tickets_flow_idx on public.tickets(flow_id) where flow_id is not null;
create index if not exists tickets_search_idx on public.tickets
  using gin (to_tsvector('simple', coalesce(name, '') || ' ' || coalesce(description_plain, '')));

create table if not exists public.ticket_history (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references public.tickets(id) on delete cascade,
  actor_id uuid not null references public.profiles(id),
  action text not null check (action in
    ('created', 'assigned', 'reassigned', 'category_changed',
     'theme_changed', 'flow_changed', 'status_changed', 'closed', 'reopened')),
  from_value jsonb,
  to_value jsonb,
  created_at timestamptz not null default now()
);

create index if not exists ticket_history_ticket_idx
  on public.ticket_history(ticket_id, created_at desc);

create table if not exists public.conversation_tickets (
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  ticket_id uuid not null references public.tickets(id) on delete cascade,
  linked_by uuid not null references public.profiles(id),
  linked_at timestamptz not null default now(),
  primary key (conversation_id, ticket_id)
);

create index if not exists conversation_tickets_ticket_idx
  on public.conversation_tickets(ticket_id);

create table if not exists public.ticket_messages (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references public.tickets(id) on delete cascade,
  author_id uuid not null references public.profiles(id),
  body jsonb not null,
  body_plain text not null,
  role_at_send text not null check (role_at_send in ('admin', 'supervisor', 'soporte')),
  fade_step int not null check (fade_step >= 0),
  created_at timestamptz not null default now()
);

create index if not exists ticket_messages_ticket_idx
  on public.ticket_messages(ticket_id, created_at desc);

create table if not exists public.role_color_settings (
  role text primary key check (role in ('admin', 'supervisor', 'soporte')),
  base_color text not null,
  fade_steps int not null default 5 check (fade_steps between 1 and 10),
  updated_by uuid references public.profiles(id),
  updated_at timestamptz not null default now()
);

insert into public.role_color_settings (role, base_color, fade_steps) values
  ('admin',     '#1e3a8a', 5),
  ('supervisor', '#7c3aed', 5),
  ('soporte',   '#16a34a', 5)
on conflict (role) do nothing;

-- =====================================================
-- PART 5: RLS — read-all for authenticated, writes via service-role
-- =====================================================

alter table public.profiles           enable row level security;
alter table public.contacts           enable row level security;
alter table public.conversations      enable row level security;
alter table public.messages           enable row level security;
alter table public.tags               enable row level security;
alter table public.contact_tags       enable row level security;
alter table public.pipeline_stages    enable row level security;
alter table public.conversation_stages enable row level security;
alter table public.notes              enable row level security;
alter table public.categories         enable row level security;
alter table public.themes             enable row level security;
alter table public.flows              enable row level security;
alter table public.tickets            enable row level security;
alter table public.ticket_messages    enable row level security;
alter table public.ticket_history     enable row level security;
alter table public.conversation_tickets enable row level security;
alter table public.role_color_settings enable row level security;

-- profiles: read all authed; self update; admin manages all
drop policy if exists "profiles authed read" on public.profiles;
create policy "profiles authed read"
  on public.profiles for select to authenticated using (true);

drop policy if exists "profiles self update" on public.profiles;
create policy "profiles self update"
  on public.profiles for update to authenticated
  using (auth.uid() = id) with check (auth.uid() = id);

drop policy if exists "profiles admin manage" on public.profiles;
create policy "profiles admin manage"
  on public.profiles for all to authenticated
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'))
  with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'));

-- Generic authed read for everything else
drop policy if exists "contacts authed read" on public.contacts;
create policy "contacts authed read" on public.contacts for select to authenticated using (true);

drop policy if exists "conversations authed read" on public.conversations;
create policy "conversations authed read" on public.conversations for select to authenticated using (true);

drop policy if exists "messages authed read" on public.messages;
create policy "messages authed read" on public.messages for select to authenticated using (true);

drop policy if exists "tags authed read" on public.tags;
create policy "tags authed read" on public.tags for select to authenticated using (true);

drop policy if exists "contact_tags authed read" on public.contact_tags;
create policy "contact_tags authed read" on public.contact_tags for select to authenticated using (true);

drop policy if exists "pipeline_stages authed read" on public.pipeline_stages;
create policy "pipeline_stages authed read" on public.pipeline_stages for select to authenticated using (true);

drop policy if exists "conversation_stages authed read" on public.conversation_stages;
create policy "conversation_stages authed read" on public.conversation_stages for select to authenticated using (true);

drop policy if exists "notes authed read" on public.notes;
create policy "notes authed read" on public.notes for select to authenticated using (true);

drop policy if exists "categories authed read" on public.categories;
create policy "categories authed read" on public.categories for select to authenticated using (true);

drop policy if exists "themes authed read" on public.themes;
create policy "themes authed read" on public.themes for select to authenticated using (true);

drop policy if exists "flows authed read" on public.flows;
create policy "flows authed read" on public.flows for select to authenticated using (true);

drop policy if exists "tickets authed read" on public.tickets;
create policy "tickets authed read" on public.tickets for select to authenticated using (true);

drop policy if exists "ticket_messages authed read" on public.ticket_messages;
create policy "ticket_messages authed read" on public.ticket_messages for select to authenticated using (true);

drop policy if exists "ticket_history authed read" on public.ticket_history;
create policy "ticket_history authed read" on public.ticket_history for select to authenticated using (true);

drop policy if exists "conversation_tickets authed read" on public.conversation_tickets;
create policy "conversation_tickets authed read" on public.conversation_tickets for select to authenticated using (true);

drop policy if exists "role_color_settings authed read" on public.role_color_settings;
create policy "role_color_settings authed read" on public.role_color_settings for select to authenticated using (true);

-- Writes are intentionally NOT given to authenticated role. The backend uses
-- SUPABASE_SECRET_KEY (service-role) to bypass RLS for mutations.

-- =====================================================
-- PART 6: Triggers
-- =====================================================

-- updated_at on contacts (existing)
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists contacts_touch_updated_at on public.contacts;
create trigger contacts_touch_updated_at
  before update on public.contacts
  for each row execute function public.touch_updated_at();

-- updated_at on new tables
drop trigger if exists categories_touch_updated_at on public.categories;
create trigger categories_touch_updated_at
  before update on public.categories
  for each row execute function public.touch_updated_at();

drop trigger if exists themes_touch_updated_at on public.themes;
create trigger themes_touch_updated_at
  before update on public.themes
  for each row execute function public.touch_updated_at();

drop trigger if exists flows_touch_updated_at on public.flows;
create trigger flows_touch_updated_at
  before update on public.flows
  for each row execute function public.touch_updated_at();

drop trigger if exists tickets_touch_updated_at on public.tickets;
create trigger tickets_touch_updated_at
  before update on public.tickets
  for each row execute function public.touch_updated_at();

-- Auto-create profile on new auth user (role defaults to 'soporte')
create or replace function public.handle_new_user()
returns trigger language plpgsql
security definer set search_path = public as $$
begin
  insert into public.profiles (id, display_name, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'display_name', split_part(new.email, '@', 1)),
    'soporte'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Bump conversation on new message (existing)
create or replace function public.bump_conversation_on_message()
returns trigger language plpgsql as $$
declare preview text;
begin
  preview := coalesce(left(new.body, 200), '[media]');
  update public.conversations
     set last_message_at = new.created_at,
         last_message_preview = preview
   where id = new.conversation_id;
  if new.direction = 'in' then
    update public.conversations
       set unread_count = unread_count + 1
     where id = new.conversation_id;
  end if;
  return new;
end;
$$;

drop trigger if exists messages_bump_conversation on public.messages;
create trigger messages_bump_conversation
  after insert on public.messages
  for each row execute function public.bump_conversation_on_message();

-- Reset unread on assign (existing)
create or replace function public.reset_unread_on_assign()
returns trigger language plpgsql as $$
begin
  if new.assigned_agent_id is not null
     and (old.assigned_agent_id is null
          or old.assigned_agent_id is distinct from new.assigned_agent_id) then
    new.unread_count := 0;
  end if;
  return new;
end;
$$;

drop trigger if exists conversations_reset_unread_on_assign on public.conversations;
create trigger conversations_reset_unread_on_assign
  before update on public.conversations
  for each row execute function public.reset_unread_on_assign();

-- =====================================================
-- PART 7: Realtime publication + storage bucket
-- =====================================================

alter publication supabase_realtime add table public.messages;
alter publication supabase_realtime add table public.conversations;
alter publication supabase_realtime add table public.tickets;
alter publication supabase_realtime add table public.ticket_messages;
alter publication supabase_realtime add table public.conversation_tickets;

insert into storage.buckets (id, name, public)
values ('whatsapp-media', 'whatsapp-media', false)
on conflict (id) do nothing;

drop policy if exists "whatsapp-media authed upload" on storage.objects;
create policy "whatsapp-media authed upload"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'whatsapp-media');

drop policy if exists "whatsapp-media authed read" on storage.objects;
create policy "whatsapp-media authed read"
  on storage.objects for select to authenticated
  using (bucket_id = 'whatsapp-media');

drop policy if exists "whatsapp-media authed delete" on storage.objects;
create policy "whatsapp-media authed delete"
  on storage.objects for delete to authenticated
  using (bucket_id = 'whatsapp-media');

-- =====================================================
-- PART 8: Promote your first user to admin
-- =====================================================
-- After signing up at least one user, run this (replace <USER_ID>):
--
--   update public.profiles set role = 'admin' where id = '<USER_ID>';
--
-- =====================================================