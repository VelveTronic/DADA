-- Owner-only account editing and active staff self-service profile updates.
--
-- GoTrue credentials remain outside Postgres. These RPCs own only the public
-- profile half and deliberately run under the caller's JWT, so an exposed
-- Server Action is not the final authorization boundary.

-- The legacy one-field customer status endpoint used to be manager+. Status is
-- now part of account editing, which the owner explicitly restricted to the
-- superadministrator. Replacing the function also closes the old direct RPC.
create or replace function public.staff_set_customer_active(
  p_user_id uuid,
  p_active boolean
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.is_staff_at_least('owner') then
    raise exception 'OWNER_ONLY' using errcode = '42501';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('dada.staff-role-admin', 0)
  );
  if not private.is_staff_at_least('owner') then
    raise exception 'OWNER_ONLY' using errcode = '42501';
  end if;
  if p_user_id is null then
    raise exception 'BAD_TARGET' using errcode = '22023';
  end if;
  if p_active is null then
    raise exception 'BAD_ACTIVE' using errcode = '22023';
  end if;

  update public.portal_users
  set is_active = p_active
  where id = p_user_id;

  return found;
end
$$;

create function public.staff_update_customer_account(
  p_user_id uuid,
  p_display_name text,
  p_company_id uuid,
  p_active boolean
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_display_name text := nullif(pg_catalog.btrim(p_display_name), '');
begin
  if not private.is_staff_at_least('owner') then
    raise exception 'OWNER_ONLY' using errcode = '42501';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('dada.staff-role-admin', 0)
  );
  if not private.is_staff_at_least('owner') then
    raise exception 'OWNER_ONLY' using errcode = '42501';
  end if;
  if p_user_id is null then
    raise exception 'BAD_TARGET' using errcode = '22023';
  end if;
  if v_display_name is null or pg_catalog.length(v_display_name) > 80 then
    raise exception 'BAD_NAME' using errcode = '22023';
  end if;
  if p_company_id is null or not exists (
    select 1 from public.companies as company where company.id = p_company_id
  ) then
    raise exception 'BAD_COMPANY' using errcode = '22023';
  end if;
  if p_active is null then
    raise exception 'BAD_ACTIVE' using errcode = '22023';
  end if;

  update public.portal_users
  set display_name = v_display_name,
      company_id = p_company_id,
      is_active = p_active
  where id = p_user_id;

  return found;
end
$$;

create function public.staff_update_staff_account(
  p_user_id uuid,
  p_display_name text,
  p_role text,
  p_active boolean
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_display_name text := nullif(pg_catalog.btrim(p_display_name), '');
begin
  if not private.is_staff_at_least('owner') then
    raise exception 'OWNER_ONLY' using errcode = '42501';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('dada.staff-role-admin', 0)
  );
  if not private.is_staff_at_least('owner') then
    raise exception 'OWNER_ONLY' using errcode = '42501';
  end if;
  if p_user_id is null then
    raise exception 'BAD_TARGET' using errcode = '22023';
  end if;
  if p_user_id = (select auth.uid()) then
    raise exception 'SELF_FORBIDDEN' using errcode = '42501';
  end if;
  if v_display_name is null or pg_catalog.length(v_display_name) > 80 then
    raise exception 'BAD_NAME' using errcode = '22023';
  end if;
  if p_role is null or p_role not in ('staff', 'manager', 'owner') then
    raise exception 'BAD_ROLE' using errcode = '22023';
  end if;
  if p_active is null then
    raise exception 'BAD_ACTIVE' using errcode = '22023';
  end if;

  update public.staff_users
  set display_name = v_display_name,
      role = p_role,
      is_active = p_active
  where id = p_user_id;

  return found;
end
$$;

-- The personal settings page derives the target from auth.uid(). It cannot
-- change role or status and it only matches an active staff row.
create function public.staff_update_own_display_name(p_display_name text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_display_name text := nullif(pg_catalog.btrim(p_display_name), '');
begin
  if v_display_name is null or pg_catalog.length(v_display_name) > 80 then
    raise exception 'BAD_NAME' using errcode = '22023';
  end if;

  update public.staff_users
  set display_name = v_display_name
  where id = (select auth.uid())
    and is_active;

  return found;
end
$$;

revoke all on function public.staff_update_customer_account(
  uuid, text, uuid, boolean
) from public, anon, authenticated, service_role;
revoke all on function public.staff_update_staff_account(
  uuid, text, text, boolean
) from public, anon, authenticated, service_role;
revoke all on function public.staff_update_own_display_name(text)
  from public, anon, authenticated, service_role;

grant execute on function public.staff_update_customer_account(
  uuid, text, uuid, boolean
) to authenticated;
grant execute on function public.staff_update_staff_account(
  uuid, text, text, boolean
) to authenticated;
grant execute on function public.staff_update_own_display_name(text)
  to authenticated;
