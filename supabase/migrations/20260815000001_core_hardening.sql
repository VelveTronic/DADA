-- 0001b_core_hardening: effective function ACLs.
-- 0001's "revoke from anon" was a no-op: Postgres grants EXECUTE on new functions
-- to PUBLIC by default and anon inherits it. Revoke from PUBLIC, then grant back
-- to the roles that need these helpers (RLS policies run them as the invoking role).
revoke execute on function public.is_staff() from public;
revoke execute on function public.my_company_id() from public;
grant execute on function public.is_staff() to authenticated, service_role;
grant execute on function public.my_company_id() to authenticated, service_role;
-- Advisor WARN function_search_path_mutable on the trigger function:
alter function public.set_updated_at() set search_path = '';
