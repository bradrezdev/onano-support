-- PR #2 · Retención y purga física de adjuntos
--
-- Desvincular un adjunto (borrar la fila de `ticket_message_attachments`)
-- NUNCA borra el objeto: la misma ruta puede vivir en otro ticket o en otro
-- mensaje, y borrarla aquí deja roto al que todavía la referencia.
--
-- El borrado físico pasa a ser una operación aparte, autorizada, que:
--   1 · exige `admin`/`supervisor` (lo decide el backend, no una política),
--   2 · comprueba que NO queda ninguna referencia (ningún vínculo de ticket a
--       un mensaje cuyo `media_urls` incluye esa ruta),
--   3 · comprueba que se respetó la ventana de conservación (`RETENTION_DAYS`,
--       30 días por defecto — supuesto declarado, configurable),
--   4 · borra el objeto del bucket y deja bitácora en una tabla append-only.
--
-- La bitácora es append-only como `conversation_audit_log`: se puede insertar
-- y leer, pero no reescribir. Sin `service_role` no hay forma de reescribir el
-- pasado desde la app.
--
-- Convenciones:
--   · Los SQLSTATE propios de estas funciones empiezan por 'C' para no
--     chocar con los estándar de PostgreSQL.

-- =====================================================
-- 1 · Bitácora de purgas (append-only)
-- =====================================================

create table if not exists public.attachment_purge_log (
  id uuid primary key default gen_random_uuid(),
  -- El ticket puede desaparecer: la bitácora NO se borra con él.
  ticket_id uuid references public.tickets(id) on delete set null,
  -- Sin FK: el mensaje puede borrarse con su conversación y el rastro de la
  -- purga tiene que sobrevivir a eso.
  message_id uuid not null,
  media_path text not null,
  actor_id uuid not null,
  reason text not null check (char_length(btrim(reason)) between 1 and 500),
  created_at timestamptz not null default now()
);

create index if not exists attachment_purge_log_path_idx
  on public.attachment_purge_log (media_path, created_at desc);

create index if not exists attachment_purge_log_actor_idx
  on public.attachment_purge_log (actor_id, created_at desc);

revoke all on public.attachment_purge_log from anon, authenticated;
grant select, insert on public.attachment_purge_log to service_role;
revoke update, delete, truncate on public.attachment_purge_log from service_role;

comment on table public.attachment_purge_log is
  'Bitácora append-only de purgas físicas de adjuntos: actor, ticket, mensaje, ruta del objeto, motivo y fecha.';

-- =====================================================
-- 2 · Índice para la comprobación de referencias
-- =====================================================
-- La purga busca los mensajes cuyo `media_urls` CONTIENE la ruta que se va a
-- borrar. `media_urls` es un JSONB sin unicidad: la misma ruta puede vivir en
-- varios mensajes, y por eso la pregunta es "¿queda alguna referencia?".

create index if not exists messages_media_urls_idx
  on public.messages using gin (media_urls);

-- =====================================================
-- 3 · La purga: bitácora y desvinculo en la MISMA transacción
-- =====================================================
-- El objeto de Storage no se puede borrar desde Postgres, pero la parte de
-- base de datos sí: el vínculo desaparece y el rastro aparece juntos, o no
-- pasa nada. La función es `security definer` porque escribe en la bitácora
-- que `service_role` no puede modificar.

create or replace function public.purge_attachment_record(
  p_ticket_id uuid,
  p_message_id uuid,
  p_actor_id uuid,
  p_media_path text,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_reason is null or char_length(btrim(p_reason)) < 1 then
    raise exception 'reason_required' using errcode = 'C0011';
  end if;

  -- El vínculo que se purga desaparece con la purga.
  delete from public.ticket_message_attachments
   where ticket_id = p_ticket_id
     and message_id = p_message_id;

  insert into public.attachment_purge_log (
    ticket_id, message_id, media_path, actor_id, reason
  ) values (
    p_ticket_id, p_message_id, p_media_path, p_actor_id, btrim(p_reason)
  );
end;
$$;

revoke all on function public.purge_attachment_record(uuid, uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.purge_attachment_record(uuid, uuid, uuid, text, text) to service_role;

comment on function public.purge_attachment_record(uuid, uuid, uuid, text, text) is
  'Desvincula el adjunto y deja la bitácora de la purga en la MISMA transacción. Lo llama el backend después de comprobar referencias y ventana de conservación.';
