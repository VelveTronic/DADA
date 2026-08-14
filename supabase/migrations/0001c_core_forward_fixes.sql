-- 0001c_core_forward_fixes: pre-catalog hardening from the Task 4 quality review.
-- Accepted state, documented: is_staff()/my_company_id() stay in the public schema
-- (advisor WARN authenticated_security_definer_function_executable on both is a
-- false positive - parameterless, auth.uid()-scoped - and revoking authenticated
-- would break every RLS policy; do NOT "fix" it).

-- 1) Table-level DML grants. Supabase default privileges hand anon/authenticated
--    full DML on every new table; RLS is then the only gate. Cut what each role
--    can never legitimately do, so a future careless policy cannot become a breach
--    (TOKACHI C1 pattern). Staff writes to companies/portal_users flow through
--    PostgREST as authenticated and stay RLS-gated; staff_users writes are
--    service_role-only (no write policy exists on purpose).
revoke all on public.companies, public.portal_users, public.staff_users from anon;
revoke insert, update, delete, truncate, references, trigger on public.staff_users from authenticated;
revoke truncate, references, trigger on public.companies, public.portal_users from authenticated;
revoke execute on function public.set_updated_at() from public;

-- 2) InitPlan-wrap RLS predicates so helpers evaluate once per statement, not per
--    row (perf advisor auth_rls_initplan; tasks 5-6 copy this pattern onto tables
--    that will actually grow).
drop policy companies_select on public.companies;
create policy companies_select on public.companies for select to authenticated
  using ((select public.is_staff()) or id = (select public.my_company_id()));
drop policy companies_staff_write on public.companies;
create policy companies_staff_write on public.companies for all to authenticated
  using ((select public.is_staff())) with check ((select public.is_staff()));
drop policy portal_users_select on public.portal_users;
create policy portal_users_select on public.portal_users for select to authenticated
  using (id = (select auth.uid()) or (select public.is_staff()));
drop policy portal_users_staff_write on public.portal_users;
create policy portal_users_staff_write on public.portal_users for all to authenticated
  using ((select public.is_staff())) with check ((select public.is_staff()));
drop policy staff_users_self_select on public.staff_users;
create policy staff_users_self_select on public.staff_users for select to authenticated
  using (id = (select auth.uid()));

-- 3) Consistency with 0001b: pin the helpers to '' too (bodies fully qualify
--    public.* and auth.uid(), so this is behavior-safe).
alter function public.is_staff() set search_path = '';
alter function public.my_company_id() set search_path = '';

-- 4) FK index the staff screens will need; audit timestamps on both user tables.
create index portal_users_company on public.portal_users(company_id);
alter table public.portal_users add column updated_at timestamptz not null default now();
create trigger portal_users_updated_at before update on public.portal_users
  for each row execute function public.set_updated_at();
alter table public.staff_users add column updated_at timestamptz not null default now();
create trigger staff_users_updated_at before update on public.staff_users
  for each row execute function public.set_updated_at();
