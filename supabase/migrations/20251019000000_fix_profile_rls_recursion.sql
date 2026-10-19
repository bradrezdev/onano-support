-- 20251019000000_fix_profile_rls_recursion.sql
-- Fix infinite recursion in profiles RLS. The "profiles admin manage" policy
-- referenced profiles from within its USING clause, which Postgres flags as
-- infinite recursion and rejects ALL queries against profiles (even with the
-- service-role key, because the policy planner evaluates expressions at plan time).
--
-- Fix: introduce a SECURITY DEFINER function that reads the role from the
-- JWT, then rewrite the admin policy to call that function. SECURITY DEFINER
-- runs as the function owner (postgres role), bypassing RLS and breaking the
-- recursion.

create or replace function public.current_user_role_safe()
returns text
language sql
security definer
stable
set search_path = public
as $$
  select coalesce(
    (select role::text from public.profiles where id = auth.uid()),
    ''
  );
$$;

drop policy if exists "profiles admin manage" on public.profiles;
create policy "profiles admin manage"
  on public.profiles for all to authenticated
  using (public.current_user_role_safe() = 'admin')
  with check (public.current_user_role_safe() = 'admin');