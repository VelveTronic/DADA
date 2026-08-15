-- RLS policies run these helpers for authenticated requests. The private schema is
-- not exposed by PostgREST, so this grants only the minimum policy-time access.
grant usage on schema private to authenticated;
grant execute on function private.is_staff() to authenticated;
grant execute on function private.my_company_id() to authenticated;

-- Trigger internals are never part of the authenticated API surface.
revoke execute on function private.enforce_exclusive_user_role() from authenticated;
