-- Major incidents (C2: "incidencias mayores").
--
-- A ficha del cliente needs to answer "is this person a chronic problem or a
-- one-off?". Counting tickets cannot tell you that: three tickets in a year
-- is normal, three in a week is a pattern. `is_major` is the human judgement
-- a Supervisor makes, which is exactly the kind of thing a boolean column is
-- for — the system can count them, the person decides which ones qualify.
--
-- Partial index because the count query only ever asks for the majors.

alter table public.tickets
  add column if not exists is_major boolean not null default false;

comment on column public.tickets.is_major is
  'Flagged by a human as a major incident. Used by the client ficha (C2).';

-- "Incidencias mayores de este cliente": the only query that filters on it.
create index if not exists tickets_major_contact_idx
  on public.tickets(contact_id, updated_at desc)
  where is_major;

analyze public.tickets;