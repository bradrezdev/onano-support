-- E3 · Recepción de WhatsApp — aceptación entrante atómica
--
-- El webhook entrante tenía tres huecos reales:
--
--   1 · DESCARTABA al contacto desconocido (`200 { skipped: 'unknown_contact' }`):
--       el primer mensaje de un cliente nuevo nunca llegaba a la cola.
--   2 · ACKEEBA los errores de almacenamiento con 200: Twilio no reintentaba
--       y el mensaje se perdía sin que nadie lo notara.
--   3 · La aceptación no era una operación: buscar el cliente, abrir el hilo
--       e insertar el mensaje eran tres pasos, y dos entregas simultáneas
--       del mismo MessageSid podían dejar DOS hilos.
--
-- Aquí se resuelve de una vez, en UNA transacción y serializada por cliente:
--
--   · `conversations.channel` — el canal es una dimensión explícita, así que
--     "el hilo del mismo canal" es una regla verificable.
--   · `accept_inbound_whatsapp(...)` — `security definer`:
--       · bloqueo de aviso por cliente (`pg_advisory_xact_lock`): dos entregas
--         simultáneas del mismo número se serializan y no pueden crear dos
--         hilos ni subir dos veces el contador de no leídos.
--       · el cliente se busca por número normalizado y se crea si no existe
--         (con el nombre de perfil de WhatsApp cuando viene).
--       · el hilo del canal se REUTILIZA; si estaba `closed` se REABRE (mismo
--         `conversation_id`, `status` → 'open'), nunca se crea un segundo.
--       · el mensaje se inserta ignorando un `MessageSid` repetido, y la
--         función devuelve si se insertó de verdad: el contador de no leídos
--         (disparador `bump_conversation_on_message`) solo se mueve una vez.
--
-- Convenciones:
--   · Los SQLSTATE propios de la app empiezan por 'C' para no chocar con los
--     estándar de PostgreSQL (C0001..C0010 los usa la autorización de
--     conversaciones; aquí siguen C0011 y C0012).

-- =====================================================
-- 1 · El canal de la conversación
-- =====================================================

alter table public.conversations
  add column if not exists channel text not null default 'whatsapp';

comment on column public.conversations.channel is
  'Canal de la conversación (hoy solo ''whatsapp''). El hilo del cliente se busca por (cliente, canal).';

-- La búsqueda del hilo es por (cliente, canal) y se ordena por antigüedad:
-- ese índice es el que usa la aceptación entrante.
create index if not exists conversations_contact_channel_idx
  on public.conversations (contact_id, channel, created_at);

-- =====================================================
-- 2 · Aceptación entrante
-- =====================================================

drop function if exists public.accept_inbound_whatsapp(text, text, text, text, jsonb);

create or replace function public.accept_inbound_whatsapp(
  p_phone text,
  p_profile_name text,
  p_twilio_sid text,
  p_body text,
  p_media_urls jsonb default '[]'::jsonb
)
returns table (
  conversation_id uuid,
  message_id uuid,
  contact_id uuid,
  inserted boolean,
  status text,
  unread_count integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_phone text;
  v_name text;
  v_contact public.contacts%rowtype;
  v_conv public.conversations%rowtype;
  v_msg public.messages%rowtype;
  v_unread integer;
  v_inserted boolean := false;
begin
  -- Normalización E.164: la misma que hace la API antes de llamar (queda el
  -- '+' y solo los dígitos), para que el número buscado sea siempre el mismo.
  v_phone := '+' || regexp_replace(btrim(coalesce(p_phone, '')), '\D', '', 'g');
  if v_phone = '+' then
    raise exception 'invalid_phone' using errcode = 'C0011';
  end if;
  if p_twilio_sid is null or btrim(p_twilio_sid) = '' then
    raise exception 'missing_sid' using errcode = 'C0012';
  end if;

  v_name := nullif(btrim(coalesce(p_profile_name, '')), '');

  -- Bloqueo de aviso por cliente. Es lo que serializa dos entregas
  -- simultáneas del mismo número: la segunda espera aquí y, al despertar,
  -- ya ve el cliente y el hilo que creó la primera.
  perform pg_advisory_xact_lock(hashtextextended(v_phone, 0));

  -- El cliente: se busca por número normalizado y se crea si no existe.
  -- Un cliente dado de baja (deleted_at) se reutiliza: su número sigue
  -- siendo único y no hay forma de crear otro con el mismo número.
  select * into v_contact
    from public.contacts c
   where c.whatsapp_number = v_phone
     for update;
  if not found then
    insert into public.contacts (whatsapp_number, name)
    values (v_phone, v_name)
    on conflict (whatsapp_number) do nothing
    returning * into v_contact;
    if v_contact.id is null then
      select * into v_contact
        from public.contacts c
       where c.whatsapp_number = v_phone;
    end if;
  end if;

  -- El hilo del canal: se reutiliza. Si estaba cerrado, se REABRE con el
  -- mismo conversation_id; no se crea un segundo hilo para el mismo cliente.
  select * into v_conv
    from public.conversations c
   where c.contact_id = v_contact.id
     and c.channel = 'whatsapp'
   order by c.created_at asc
   limit 1;
  if not found then
    insert into public.conversations (contact_id, channel, status)
    values (v_contact.id, 'whatsapp', 'open')
    returning * into v_conv;
  elsif v_conv.status = 'closed' then
    update public.conversations c
       set status = 'open'
     where c.id = v_conv.id
    returning * into v_conv;
  end if;

  -- El mensaje: idempotente por MessageSid. Un MessageSid repetido NO es un
  -- error: no se inserta nada y el disparador de no leídos no se dispara.
  select * into v_msg
    from public.messages m
   where m.twilio_sid = p_twilio_sid;
  if not found then
    insert into public.messages (conversation_id, direction, body, media_urls, twilio_sid)
    values (v_conv.id, 'in', p_body, coalesce(p_media_urls, '[]'::jsonb), p_twilio_sid)
    returning * into v_msg;
    v_inserted := true;
  end if;

  -- El contador de no leídos lo sube el disparador al insertar el mensaje:
  -- se relee DESPUÉS para reportar el valor real (un duplicado no lo mueve).
  select c.unread_count into v_unread
    from public.conversations c
   where c.id = v_msg.conversation_id;

  return query
    select v_msg.conversation_id, v_msg.id, v_contact.id, v_inserted, v_conv.status, v_unread;
end;
$$;

revoke all on function public.accept_inbound_whatsapp(text, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.accept_inbound_whatsapp(text, text, text, text, jsonb) to service_role;

comment on function public.accept_inbound_whatsapp(text, text, text, text, jsonb) is
  'Acepta un mensaje entrante de WhatsApp en UNA transacción serializada por cliente: crea el cliente si falta, reutiliza (y reabre) el hilo del canal e inserta el mensaje ignorando un MessageSid repetido. Devuelve si el mensaje se insertó de verdad.';
