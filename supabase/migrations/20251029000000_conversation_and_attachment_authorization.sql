-- PR #2 · Autorización de conversaciones y adjuntos
--
-- Cierra tres huecos reales, todos del lado del backend (el `service_role`
-- salta RLS, así que la autorización es explícita y no puede quedar en una
-- política):
--
--   1 · ESCRITURA DE MENSAJES: `POST /api/conversations/:id/messages` exigía
--       el permiso `conversation.assign` pero NUNCA comparaba el titular del
--       chat: cualquier agente con el permiso escribía en un chat ajeno
--       (201). Ahora la escritura pasa por una función que valida la
--       asignación y guarda el mensaje en la MISMA transacción.
--
--   2 · TRANSFERENCIAS: `reassignConversation` ignoraba al actor, no exigía
--       motivo, no versionaba y no auditaba. Ahora la transferencia exige
--       permiso + motivo + versión vigente, y escribe el cambio y su
--       bitácora en una sola transacción, con bloqueo de fila: dos
--       peticiones con la misma versión producen UN cambio y UN evento.
--
--   3 · ADJUNTOS: el bucket `whatsapp-media` era privado, pero sus políticas
--       de Storage permitían a `authenticated` insertar, LEER y BORRAR
--       cualquier objeto. Ahora la API es la única vía: el objeto se sirve
--       por URL firmada tras autorizar y se borra con el adjunto.
--
-- Convenciones:
--   · Los objetos propios de la app viven en el bucket `whatsapp-media` bajo
--     el prefijo `attachments/`. Los `media_urls` que apuntan a Twilio
--     (https://...) son externos y NO se borran ni se sirven desde aquí.
--   · Los SQLSTATE propios de estas funciones empiezan por 'C' para no
--     chocar con los estándar de PostgreSQL.

-- =====================================================
-- 1 · Versión de asignación
-- =====================================================
-- La versión se incrementa en cada transferencia. Es el optimistic lock: el
-- cliente envía la versión que vio y, si el chat cambió en otra pestaña, la
-- API lo rechaza con 409 en vez de sobrescribir el trabajo de otro.

alter table public.conversations
  add column if not exists assignment_version integer not null default 1;

-- =====================================================
-- 2 · Bitácora de transferencias (append-only)
-- =====================================================
-- Mismo patrón que `admin_audit_log`: se puede insertar y leer, pero no
-- actualizar ni borrar. Sin `service_role` no hay forma de reescribir el
-- pasado desde la app.

create table if not exists public.conversation_audit_log (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  actor_id uuid not null,
  previous_assignee_id uuid,
  new_assignee_id uuid,
  reason text not null check (char_length(btrim(reason)) between 1 and 500),
  version_before integer not null,
  version_after integer not null,
  created_at timestamptz not null default now()
);

create index if not exists conversation_audit_log_conversation_idx
  on public.conversation_audit_log (conversation_id, created_at desc);
create index if not exists conversation_audit_log_actor_idx
  on public.conversation_audit_log (actor_id, created_at desc);

revoke all on public.conversation_audit_log from anon, authenticated;
grant select, insert on public.conversation_audit_log to service_role;
revoke update, delete, truncate on public.conversation_audit_log from service_role;

comment on table public.conversation_audit_log is
  'Bitácora append-only de transferencias de conversaciones: actor, titular anterior, titular nuevo, motivo, versión y fecha.';

-- =====================================================
-- 3 · Transferencia de conversaciones
-- =====================================================
-- Una sola operación atómica: bloqueo de fila, comprobación de versión,
-- cambio y bitácora. La función es `security definer` porque debe escribir
-- en la bitácora que `service_role` no puede modificar.

-- La forma de retorno cambió (ahora devuelve la fila completa): PostgreSQL
-- no permite cambiar el tipo de retorno con CREATE OR REPLACE, así que la
-- función se suelta y se vuelve a crear.
drop function if exists public.reassign_conversation(uuid, uuid, uuid, text, integer);

create or replace function public.reassign_conversation(
  p_conversation_id uuid,
  p_actor_id uuid,
  p_new_assignee_id uuid,
  p_reason text,
  p_expected_version integer
)
returns table (
  conversation_id uuid,
  contact_id uuid,
  assigned_agent_id uuid,
  status text,
  last_message_at timestamptz,
  last_message_preview text,
  unread_count integer,
  created_at timestamptz,
  assignment_version integer,
  previous_assignee_id uuid,
  changed_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_conv public.conversations%rowtype;   -- estado ANTES del cambio
  v_new public.conversations%rowtype;    -- estado DESPUÉS del cambio
  v_version integer;
begin
  if p_reason is null or char_length(btrim(p_reason)) < 1 then
    raise exception 'reason_required' using errcode = 'C0001';
  end if;
  if p_expected_version is null then
    raise exception 'version_required' using errcode = 'C0002';
  end if;

  -- Bloqueo de fila: la segunda petición con la misma versión espera aquí y,
  -- al despertar, ve la versión nueva: un solo cambio y un solo evento.
  select * into v_conv
    from public.conversations c
   where c.id = p_conversation_id
     for update;
  if not found then
    raise exception 'conversation_not_found' using errcode = 'C0003';
  end if;

  if v_conv.assignment_version <> p_expected_version then
    raise exception 'version_conflict' using errcode = 'C0004';
  end if;

  if p_new_assignee_id is not null and not exists (
    select 1
      from public.profiles p
     where p.id = p_new_assignee_id
       and p.deleted_at is null
       and p.suspended_at is null
  ) then
    raise exception 'invalid_assignee' using errcode = 'C0005';
  end if;

  -- El alias evita la ambigüedad con las columnas de salida de la función
  -- (`assignment_version` existe en ambos sitios).
  update public.conversations c
     set assigned_agent_id = p_new_assignee_id,
         assignment_version = c.assignment_version + 1
   where c.id = p_conversation_id
  returning c.assignment_version into v_version;

  -- El estado nuevo se relee: la respuesta debe decir quién es AHORA el
  -- titular, no quién era antes del cambio.
  select * into v_new
    from public.conversations c
   where c.id = p_conversation_id;

  insert into public.conversation_audit_log (
    conversation_id, actor_id, previous_assignee_id, new_assignee_id,
    reason, version_before, version_after
  ) values (
    p_conversation_id, p_actor_id, v_conv.assigned_agent_id, p_new_assignee_id,
    btrim(p_reason), v_conv.assignment_version, v_version
  );

  return query
    select v_new.id, v_new.contact_id, v_new.assigned_agent_id, v_new.status,
           v_new.last_message_at, v_new.last_message_preview, v_new.unread_count,
           v_new.created_at, v_version, v_conv.assigned_agent_id, now();
end;
$$;

revoke all on function public.reassign_conversation(uuid, uuid, uuid, text, integer) from public, anon, authenticated;
grant execute on function public.reassign_conversation(uuid, uuid, uuid, text, integer) to service_role;

comment on function public.reassign_conversation(uuid, uuid, uuid, text, integer) is
  'Transfiere una conversación y deja la auditoría en la MISMA transacción. Exige motivo y versión vigente; con la misma versión, dos peticiones producen un solo cambio y un solo evento.';

-- =====================================================
-- 4 · Escritura de mensajes
-- =====================================================
-- Valida la asignación y guarda el mensaje en la misma operación: si el
-- chat cambió de titular mientras el agente redactaba, la función falla y
-- NO se guarda ningún mensaje (ni se encola nada: no existe cola de salida).

create or replace function public.append_outbound_message(
  p_conversation_id uuid,
  p_actor_id uuid,
  p_body text,
  p_media_urls jsonb default '[]'::jsonb,
  p_twilio_sid text default null,
  p_twilio_status text default null
)
returns table (
  id uuid,
  conversation_id uuid,
  direction text,
  body text,
  twilio_sid text,
  twilio_status text,
  sent_by_id uuid,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_conv public.conversations%rowtype;
  v_actor_role text;
  v_msg public.messages%rowtype;
begin
  if p_body is null or char_length(btrim(p_body)) < 1 then
    raise exception 'empty_body' using errcode = 'C0006';
  end if;

  -- El alias evita la ambigüedad con las columnas de salida de la función
  -- (`id` existe en ambos sitios).
  select * into v_conv
    from public.conversations c
   where c.id = p_conversation_id
     for update;
  if not found then
    raise exception 'conversation_not_found' using errcode = 'C0003';
  end if;

  select pr.role_key into v_actor_role
    from public.profiles pr
   where pr.id = p_actor_id
     and pr.deleted_at is null
     and pr.suspended_at is null;
  if v_actor_role is null then
    raise exception 'unknown_actor' using errcode = 'C0007';
  end if;

  -- Sin titular no se escribe: primero hay que tomar el chat.
  if v_conv.assigned_agent_id is null then
    raise exception 'conversation_unassigned' using errcode = 'C0008';
  end if;

  -- El titular vigente escribe. `admin`/`supervisor` pueden escribir en
  -- cualquier chat (el rol se lee del perfil, nunca del cuerpo de la
  -- petición). Cualquier otro actor que no sea el titular recibe
  -- 'assignment_changed': el chat cambió de manos mientras redactaba.
  if v_conv.assigned_agent_id <> p_actor_id
     and v_actor_role not in ('admin', 'supervisor') then
    raise exception 'assignment_changed' using errcode = 'C0009';
  end if;

  insert into public.messages (conversation_id, direction, body, media_urls, twilio_sid, twilio_status, sent_by_id)
  values (
    p_conversation_id, 'out', p_body, coalesce(p_media_urls, '[]'::jsonb),
    p_twilio_sid, p_twilio_status, p_actor_id
  )
  returning * into v_msg;

  return query
    select v_msg.id, v_msg.conversation_id, v_msg.direction, v_msg.body,
           v_msg.twilio_sid, v_msg.twilio_status, v_msg.sent_by_id, v_msg.created_at;
end;
$$;

revoke all on function public.append_outbound_message(uuid, uuid, text, jsonb, text, text) from public, anon, authenticated;
grant execute on function public.append_outbound_message(uuid, uuid, text, jsonb, text, text) to service_role;

comment on function public.append_outbound_message(uuid, uuid, text, jsonb, text, text) is
  'Guarda un mensaje saliente validando la asignación en la misma transacción. Si el chat no es del actor, falla con assignment_changed y no se guarda nada.';

-- =====================================================
-- 4.b · Tomar una conversación
-- =====================================================
-- Tomar ALSO cambia de titular: por eso bumpa la versión y deja la misma
-- auditoría que una transferencia (con motivo 'take'). La toma sigue siendo
-- un compare-and-set: si otro agente se adelantó, falla con already_taken.

create or replace function public.take_conversation(
  p_conversation_id uuid,
  p_actor_id uuid
)
returns table (
  id uuid,
  contact_id uuid,
  assigned_agent_id uuid,
  status text,
  last_message_at timestamptz,
  last_message_preview text,
  unread_count integer,
  created_at timestamptz,
  assignment_version integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_conv public.conversations%rowtype;
begin
  -- Un chat que no existe NO es un chat que otro agente tomó: son dos
  -- hechos distintos y el cliente los cuenta distinto.
  select * into v_conv
    from public.conversations c
   where c.id = p_conversation_id;
  if not found then
    raise exception 'conversation_not_found' using errcode = 'C0003';
  end if;

  -- La toma sigue siendo un compare-and-set: si otro agente se adelantó
  -- entre la lectura y la actualización, la actualización no toca nada.
  update public.conversations c
     set assigned_agent_id = p_actor_id,
         assignment_version = c.assignment_version + 1
   where c.id = p_conversation_id
     and c.assigned_agent_id is null
  returning * into v_conv;

  if not found then
    raise exception 'already_taken' using errcode = 'C0010';
  end if;

  insert into public.conversation_audit_log (
    conversation_id, actor_id, previous_assignee_id, new_assignee_id,
    reason, version_before, version_after
  ) values (
    p_conversation_id, p_actor_id, null, p_actor_id, 'take',
    v_conv.assignment_version - 1, v_conv.assignment_version
  );

  return query
    select v_conv.id, v_conv.contact_id, v_conv.assigned_agent_id, v_conv.status,
           v_conv.last_message_at, v_conv.last_message_preview, v_conv.unread_count,
           v_conv.created_at, v_conv.assignment_version;
end;
$$;

revoke all on function public.take_conversation(uuid, uuid) from public, anon, authenticated;
grant execute on function public.take_conversation(uuid, uuid) to service_role;

comment on function public.take_conversation(uuid, uuid) is
  'Toma una conversación sin titular (compare-and-set) y deja la auditoría del cambio de titular.';

-- =====================================================
-- 5 · Storage: la API es la única vía
-- =====================================================
-- El bucket es privado, pero las políticas de Storage permitían a
-- `authenticated` leer y BORRAR cualquier objeto del bucket: la
-- autorización de adjuntos noservía de nada porque el objeto era accesible
-- sin pasar por la API. Se retiran esas políticas: el objeto se sirve por
-- URL firmada (la emite la API tras autorizar) y se borra con el adjunto.

drop policy if exists "whatsapp-media authed upload" on storage.objects;
drop policy if exists "whatsapp-media authed read" on storage.objects;
drop policy if exists "whatsapp-media authed delete" on storage.objects;
