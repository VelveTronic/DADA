-- Database-enforced staff role boundaries for customer/staff administration.
--
-- Account credentials are still created by GoTrue before these RPCs run. The
-- database owns the profile/company half: manager+ may manage customers and
-- only owners may manage staff. Direct authenticated writes are removed so a
-- caller cannot bypass these checks with the Data API.

create function private.is_staff_at_least(p_required_role text)
returns boolean
language sql
volatile
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.staff_users as staff
    where staff.id = (select auth.uid())
      and staff.is_active
      and case p_required_role
        when 'staff' then staff.role in ('staff', 'manager', 'owner')
        when 'manager' then staff.role in ('manager', 'owner')
        when 'owner' then staff.role = 'owner'
        else false
      end
  )
$$;

-- Existing company and new company are deliberately mutually exclusive. A new
-- company and its portal profile are inserted by one function invocation, so a
-- duplicate auth profile, role conflict, or FK failure rolls the company back.
create function public.staff_provision_customer(
  p_user_id uuid,
  p_display_name text,
  p_company_id uuid default null,
  p_company_name text default null,
  p_codcli integer default null,
  p_tarcli smallint default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_display_name text := nullif(pg_catalog.btrim(p_display_name), '');
  v_company_name text;
  v_company_id uuid;
begin
  if not private.is_staff_at_least('manager') then
    raise exception 'MANAGER_ONLY' using errcode = '42501';
  end if;
  -- Reject outsiders before they can hold the shared administration lock. The
  -- post-lock check is authoritative: another owner may have changed this
  -- caller's role/active flag while this transaction was waiting.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('dada.staff-role-admin', 0)
  );
  if not private.is_staff_at_least('manager') then
    raise exception 'MANAGER_ONLY' using errcode = '42501';
  end if;
  if p_user_id is null then
    raise exception 'BAD_TARGET' using errcode = '22023';
  end if;
  if v_display_name is null or pg_catalog.length(v_display_name) > 80 then
    raise exception 'BAD_NAME' using errcode = '22023';
  end if;

  if p_company_id is not null then
    if p_company_name is not null or p_codcli is not null or p_tarcli is not null then
      raise exception 'BAD_COMPANY' using errcode = '22023';
    end if;

    select company.id
    into v_company_id
    from public.companies as company
    where company.id = p_company_id
      and company.is_active
    for share;

    if not found then
      raise exception 'BAD_COMPANY' using errcode = '22023';
    end if;
  else
    if p_company_name is null or p_codcli is null or p_tarcli is null then
      raise exception 'BAD_COMPANY' using errcode = '22023';
    end if;

    v_company_name := nullif(pg_catalog.btrim(p_company_name), '');
    if v_company_name is null or pg_catalog.length(v_company_name) > 80 then
      raise exception 'BAD_COMPANY' using errcode = '22023';
    end if;
    if p_codcli <= 0 then
      raise exception 'BAD_CODCLI' using errcode = '22023';
    end if;
    if p_tarcli < 1 or p_tarcli > 6 then
      raise exception 'BAD_TARCLI' using errcode = '22023';
    end if;

    insert into public.companies (name, codcli, tarcli)
    values (v_company_name, p_codcli, p_tarcli)
    returning id into v_company_id;
  end if;

  insert into public.portal_users (id, company_id, display_name)
  values (p_user_id, v_company_id, v_display_name);

  return v_company_id;
end
$$;

create function public.staff_provision_staff(
  p_user_id uuid,
  p_display_name text,
  p_role text
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
  if p_role is null or p_role not in ('staff', 'manager', 'owner') then
    raise exception 'BAD_ROLE' using errcode = '22023';
  end if;

  insert into public.staff_users (id, display_name, role)
  values (p_user_id, v_display_name, p_role);

  return true;
end
$$;

create function public.staff_set_customer_active(
  p_user_id uuid,
  p_active boolean
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.is_staff_at_least('manager') then
    raise exception 'MANAGER_ONLY' using errcode = '42501';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('dada.staff-role-admin', 0)
  );
  if not private.is_staff_at_least('manager') then
    raise exception 'MANAGER_ONLY' using errcode = '42501';
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

create function public.staff_set_staff_active(
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
  if p_user_id = (select auth.uid()) then
    raise exception 'SELF_FORBIDDEN' using errcode = '42501';
  end if;

  update public.staff_users
  set is_active = p_active
  where id = p_user_id;

  return found;
end
$$;

create function public.staff_set_staff_role(
  p_user_id uuid,
  p_role text
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
  if p_role is null or p_role not in ('staff', 'manager', 'owner') then
    raise exception 'BAD_ROLE' using errcode = '22023';
  end if;
  if p_user_id = (select auth.uid()) then
    raise exception 'SELF_FORBIDDEN' using errcode = '42501';
  end if;

  update public.staff_users
  set role = p_role
  where id = p_user_id;

  return found;
end
$$;

-- Customer self-service is narrower than the management RPCs: no target id is
-- accepted, only the caller's active portal row can change, and an inactive
-- company disables the operation as well as the rest of the customer portal.
create function public.update_own_display_name(p_display_name text)
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

  update public.portal_users as portal
  set display_name = v_display_name
  from public.companies as company
  where portal.id = (select auth.uid())
    and portal.is_active
    and company.id = portal.company_id
    and company.is_active;

  return found;
end
$$;

-- Reads retain their current RLS policies. Writes no longer have a table grant
-- or policy for authenticated callers; every legitimate write above runs as a
-- checked, fixed-shape SECURITY DEFINER operation.
drop policy companies_staff_insert on public.companies;
drop policy companies_staff_update on public.companies;
drop policy companies_staff_delete on public.companies;
drop policy portal_users_staff_insert on public.portal_users;
drop policy portal_users_staff_update on public.portal_users;
drop policy portal_users_staff_delete on public.portal_users;

revoke insert, update, delete on public.companies, public.portal_users
  from authenticated;

revoke all on function private.is_staff_at_least(text)
  from public, anon, authenticated, service_role;

revoke all on function public.staff_provision_customer(
  uuid, text, uuid, text, integer, smallint
) from public, anon, authenticated, service_role;
revoke all on function public.staff_provision_staff(uuid, text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.staff_set_customer_active(uuid, boolean)
  from public, anon, authenticated, service_role;
revoke all on function public.staff_set_staff_active(uuid, boolean)
  from public, anon, authenticated, service_role;
revoke all on function public.staff_set_staff_role(uuid, text)
  from public, anon, authenticated, service_role;
revoke all on function public.update_own_display_name(text)
  from public, anon, authenticated, service_role;

grant execute on function public.staff_provision_customer(
  uuid, text, uuid, text, integer, smallint
) to authenticated;
grant execute on function public.staff_provision_staff(uuid, text, text)
  to authenticated;
grant execute on function public.staff_set_customer_active(uuid, boolean)
  to authenticated;
grant execute on function public.staff_set_staff_active(uuid, boolean)
  to authenticated;
grant execute on function public.staff_set_staff_role(uuid, text)
  to authenticated;
grant execute on function public.update_own_display_name(text)
  to authenticated;
