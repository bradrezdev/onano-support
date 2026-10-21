-- profiles.created_by — who granted the account.
--
-- Every other table an admin writes to carries this: themes.created_by,
-- flows.created_by, roles.created_by, tickets.created_by. `profiles` was the
-- odd one out, so POST /api/users had nowhere to record that an admin handed
-- someone access. The column was assumed to exist by the createUser service
-- and the live smoke test is what caught it — no mock can tell you a column
-- is missing from the schema.
--
-- Same shape as tickets.created_by: a self-referential FK to profiles(id),
-- nullable because auth.users rows predate this and backfill would be a lie
-- for accounts nobody can attribute.

alter table public.profiles
  add column if not exists created_by uuid
  references public.profiles(id) on delete set null;

comment on column public.profiles.created_by is
  'Profile of the admin that created this account. Null for rows that predate it.';