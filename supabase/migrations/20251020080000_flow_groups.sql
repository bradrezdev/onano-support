-- Flow groups (recommendation 5).
--
-- "Cada proyecto nombra sus fases, pero todas pertenecen a uno de 4 grupos
-- (Pendiente, En trabajo, En espera, Terminado). Es como un semáforo: cada
-- ciudad tiene sus calles, pero el rojo significa lo mismo."
--
-- Without a group, every project invents its own vocabulary and cross-project
-- reporting is impossible — "Terminado" in Onboarding and "Cerrado" in
-- Cobranza are the same event with different labels, and no query can tell.
--
-- Four groups, not a free enum: the value of the group is that it is small
-- and fixed. A fifth group would break every rollup; a per-project group would
-- defeat the point.
--
-- The mapping is many-to-one in practice (several phases per group) but this
-- table allows a phase to opt out entirely: NULL group means "this project
-- does not use the shared vocabulary yet", which is honest rather than
-- silently filing a bespoke phase into the wrong bucket.

create table if not exists public.flow_groups (
  key text primary key,
  label text not null,
  -- Ordering across projects: 1..4. Terminal is always last because
  -- "done" is the end of the line regardless of how it is labelled.
  position int not null,
  color text not null default '#64748b',
  created_at timestamptz not null default now(),
  unique (position)
);

comment on table public.flow_groups is
  'Shared phase vocabulary (recommendation 5). Fixed set: the value is comparability.';

insert into public.flow_groups (key, label, position, color)
values
  ('pendiente', 'Pendiente',   1, '#94a3b8'),
  ('en_trabajo', 'En trabajo', 2, '#3b82f6'),
  ('en_espera',  'En espera',  3, '#f59e0b'),
  ('terminado',  'Terminado',  4, '#22c55e')
on conflict (key) do nothing;

alter table public.flows
  add column if not exists group_key text references public.flow_groups(key) on delete set null;

comment on column public.flows.group_key is
  'Which shared group this phase belongs to. NULL = project uses its own vocabulary.';

-- The grouping query in every rollup is "group by key across all themes".
create index if not exists flows_group_key_idx on public.flows(group_key);

-- Seed the existing phases by name. Guessing from labels is wrong in general
-- ("Listo" could be either), so this only maps the unambiguous ones and
-- leaves the rest NULL for a human to file.
update public.flows set group_key = 'pendiente'
where group_key is null
  and name ilike any (array['nuevo', 'pendiente', 'backlog', 'listo para empezar']);

update public.flows set group_key = 'en_trabajo'
where group_key is null
  and name ilike any (array['en progreso', 'en curso', 'in progress', 'en curso de']);

update public.flows set group_key = 'terminado'
where group_key is null
  and name ilike any (array['terminado', 'cerrado', 'resuelto', 'completado', 'done']);

analyze public.flow_groups;
analyze public.flows;