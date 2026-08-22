begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(22);

-- The account-management surface is callable through an authenticated JWT,
-- but neither anonymous callers, service-role clients, nor PUBLIC grants can
-- inherit an unchecked execution path.
select ok(
  (
    select pg_catalog.bool_and(
      has_function_privilege('authenticated', function_oid::oid, 'EXECUTE')
    )
    from pg_catalog.unnest(array[
      'public.staff_update_customer_account(uuid,text,uuid,boolean)'::regprocedure,
      'public.staff_update_staff_account(uuid,text,text,boolean)'::regprocedure,
      'public.staff_update_own_display_name(text)'::regprocedure,
      'public.staff_set_customer_active(uuid,boolean)'::regprocedure
    ]) as functions(function_oid)
  ),
  'authenticated can execute the account-management RPCs'
);
select ok(
  (
    select pg_catalog.bool_and(
      not has_function_privilege('anon', function_oid::oid, 'EXECUTE')
    )
    from pg_catalog.unnest(array[
      'public.staff_update_customer_account(uuid,text,uuid,boolean)'::regprocedure,
      'public.staff_update_staff_account(uuid,text,text,boolean)'::regprocedure,
      'public.staff_update_own_display_name(text)'::regprocedure,
      'public.staff_set_customer_active(uuid,boolean)'::regprocedure
    ]) as functions(function_oid)
  ),
  'anon cannot execute the account-management RPCs'
);
select ok(
  (
    select pg_catalog.bool_and(
      not has_function_privilege('service_role', function_oid::oid, 'EXECUTE')
    )
    from pg_catalog.unnest(array[
      'public.staff_update_customer_account(uuid,text,uuid,boolean)'::regprocedure,
      'public.staff_update_staff_account(uuid,text,text,boolean)'::regprocedure,
      'public.staff_update_own_display_name(text)'::regprocedure,
      'public.staff_set_customer_active(uuid,boolean)'::regprocedure
    ]) as functions(function_oid)
  ),
  'service role cannot execute the account-management RPCs'
);
select is(
  (
    select pg_catalog.count(*)
    from pg_catalog.pg_proc as procedure
    join pg_catalog.unnest(array[
      'public.staff_update_customer_account(uuid,text,uuid,boolean)'::regprocedure,
      'public.staff_update_staff_account(uuid,text,text,boolean)'::regprocedure,
      'public.staff_update_own_display_name(text)'::regprocedure,
      'public.staff_set_customer_active(uuid,boolean)'::regprocedure
    ]) as functions(function_oid)
      on procedure.oid = function_oid::oid
    where procedure.prosecdef
  ),
  4::bigint,
  'all account-management RPCs are security definers'
);
select is(
  (
    select pg_catalog.count(*)
    from pg_catalog.pg_proc as procedure
    join pg_catalog.unnest(array[
      'public.staff_update_customer_account(uuid,text,uuid,boolean)'::regprocedure,
      'public.staff_update_staff_account(uuid,text,text,boolean)'::regprocedure,
      'public.staff_update_own_display_name(text)'::regprocedure,
      'public.staff_set_customer_active(uuid,boolean)'::regprocedure
    ]) as functions(function_oid)
      on procedure.oid = function_oid::oid
    where exists (
      select 1
      from pg_catalog.unnest(procedure.proconfig) as settings(setting)
      where pg_catalog.split_part(settings.setting, '=', 1) = 'search_path'
        and pg_catalog.replace(
          pg_catalog.split_part(settings.setting, '=', 2),
          '"',
          ''
        ) = ''
    )
  ),
  4::bigint,
  'all account-management RPCs pin an empty search path'
);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
select
  fixture.id,
  '00000000-0000-0000-0000-000000000000'::uuid,
  'authenticated',
  'authenticated',
  fixture.email,
  '',
  pg_catalog.now(),
  '{}'::jsonb,
  '{}'::jsonb,
  pg_catalog.now(),
  pg_catalog.now()
from (
  values
    ('23000000-0000-0000-0000-000000000001'::uuid, 'account-owner@example.invalid'),
    ('23000000-0000-0000-0000-000000000002'::uuid, 'account-manager@example.invalid'),
    ('23000000-0000-0000-0000-000000000003'::uuid, 'account-staff@example.invalid'),
    ('23000000-0000-0000-0000-000000000004'::uuid, 'account-customer@example.invalid'),
    ('23000000-0000-0000-0000-000000000005'::uuid, 'account-customer-target@example.invalid'),
    ('23000000-0000-0000-0000-000000000006'::uuid, 'account-staff-target@example.invalid')
) as fixture(id, email);

insert into public.companies (id, codcli, name, tarcli, is_active)
values
(
  '23000000-0000-0000-0000-000000000101',
  930001,
  'Account Company One',
  1,
  true
),
(
  '23000000-0000-0000-0000-000000000102',
  930002,
  'Account Company Two',
  2,
  true
);

insert into public.staff_users (id, role, display_name, is_active)
values
('23000000-0000-0000-0000-000000000001', 'owner', 'Account Owner', true),
('23000000-0000-0000-0000-000000000002', 'manager', 'Account Manager', true),
('23000000-0000-0000-0000-000000000003', 'staff', 'Account Staff', true),
('23000000-0000-0000-0000-000000000006', 'staff', 'Account Staff Target', true);

insert into public.portal_users (id, company_id, display_name, is_active)
values
(
  '23000000-0000-0000-0000-000000000004',
  '23000000-0000-0000-0000-000000000101',
  'Account Customer',
  true
),
(
  '23000000-0000-0000-0000-000000000005',
  '23000000-0000-0000-0000-000000000101',
  'Account Customer Target',
  true
);

set local role authenticated;

-- Owners can atomically edit the public profile fields for customer and staff
-- accounts. GoTrue email/password changes remain a server-side concern.
select set_config(
  'request.jwt.claims',
  '{"sub":"23000000-0000-0000-0000-000000000001","role":"authenticated"}',
  true
);
select is(
  public.staff_update_customer_account(
    '23000000-0000-0000-0000-000000000005',
    '  Renamed Customer  ',
    '23000000-0000-0000-0000-000000000102',
    false
  ),
  true,
  'owner edits a customer account'
);
reset role;
select ok(
  (
    select display_name = 'Renamed Customer'
      and company_id = '23000000-0000-0000-0000-000000000102'
      and not is_active
    from public.portal_users
    where id = '23000000-0000-0000-0000-000000000005'
  ),
  'customer account edit stores normalized name, company, and status'
);
set local role authenticated;
select is(
  public.staff_update_staff_account(
    '23000000-0000-0000-0000-000000000006',
    '  Renamed Staff  ',
    'manager',
    false
  ),
  true,
  'owner edits another staff account'
);
reset role;
select ok(
  (
    select display_name = 'Renamed Staff'
      and role = 'manager'
      and not is_active
    from public.staff_users
    where id = '23000000-0000-0000-0000-000000000006'
  ),
  'staff account edit stores normalized name, role, and status'
);
set local role authenticated;

-- Manager, ordinary staff, and customer JWTs cannot use either owner-only
-- account editor. The legacy customer status RPC is owner-only as well.
select set_config(
  'request.jwt.claims',
  '{"sub":"23000000-0000-0000-0000-000000000002","role":"authenticated"}',
  true
);
select throws_ok(
  $$select public.staff_update_customer_account(
      '23000000-0000-0000-0000-000000000005',
      'Manager Customer Edit',
      '23000000-0000-0000-0000-000000000101',
      true
    )$$,
  '42501',
  'OWNER_ONLY',
  'manager cannot edit customer accounts'
);
select throws_ok(
  $$select public.staff_update_staff_account(
      '23000000-0000-0000-0000-000000000006',
      'Manager Staff Edit',
      'staff',
      true
    )$$,
  '42501',
  'OWNER_ONLY',
  'manager cannot edit staff accounts'
);
select throws_ok(
  $$select public.staff_set_customer_active(
      '23000000-0000-0000-0000-000000000005',
      true
    )$$,
  '42501',
  'OWNER_ONLY',
  'manager cannot use the legacy customer status RPC'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"23000000-0000-0000-0000-000000000003","role":"authenticated"}',
  true
);
select throws_ok(
  $$select public.staff_update_customer_account(
      '23000000-0000-0000-0000-000000000005',
      'Staff Customer Edit',
      '23000000-0000-0000-0000-000000000101',
      true
    )$$,
  '42501',
  'OWNER_ONLY',
  'ordinary staff cannot edit customer accounts'
);
select throws_ok(
  $$select public.staff_update_staff_account(
      '23000000-0000-0000-0000-000000000006',
      'Staff Staff Edit',
      'staff',
      true
    )$$,
  '42501',
  'OWNER_ONLY',
  'ordinary staff cannot edit staff accounts'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"23000000-0000-0000-0000-000000000004","role":"authenticated"}',
  true
);
select throws_ok(
  $$select public.staff_update_customer_account(
      '23000000-0000-0000-0000-000000000004',
      'Customer Self Management',
      '23000000-0000-0000-0000-000000000102',
      false
    )$$,
  '42501',
  'OWNER_ONLY',
  'customer cannot use the managed customer editor on themself'
);
select throws_ok(
  $$select public.staff_update_staff_account(
      '23000000-0000-0000-0000-000000000006',
      'Customer Staff Edit',
      'owner',
      true
    )$$,
  '42501',
  'OWNER_ONLY',
  'customer cannot edit staff accounts'
);

-- An owner uses the narrower self-service endpoint for their own name; the
-- managed staff editor cannot change their own role or active state.
select set_config(
  'request.jwt.claims',
  '{"sub":"23000000-0000-0000-0000-000000000001","role":"authenticated"}',
  true
);
select throws_ok(
  $$select public.staff_update_staff_account(
      '23000000-0000-0000-0000-000000000001',
      'Owner Self Edit',
      'staff',
      false
    )$$,
  '42501',
  'SELF_FORBIDDEN',
  'owner cannot use the managed staff editor on themself'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"23000000-0000-0000-0000-000000000003","role":"authenticated"}',
  true
);
select is(
  public.staff_update_own_display_name('  Staff Self Renamed  '),
  true,
  'active staff updates their own display name'
);
reset role;
select ok(
  (
    select display_name = 'Staff Self Renamed'
      and role = 'staff'
      and is_active
    from public.staff_users
    where id = '23000000-0000-0000-0000-000000000003'
  ),
  'staff self-service trims the name without changing role or status'
);
set local role authenticated;

select set_config(
  'request.jwt.claims',
  '{"sub":"23000000-0000-0000-0000-000000000004","role":"authenticated"}',
  true
);
select is(
  public.staff_update_own_display_name('Customer Cannot Become Staff'),
  false,
  'customer has no staff self-service target'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"23000000-0000-0000-0000-000000000001","role":"authenticated"}',
  true
);
select is(
  public.staff_set_customer_active(
    '23000000-0000-0000-0000-000000000005',
    true
  ),
  true,
  'owner can use the tightened customer status RPC'
);
reset role;
select is(
  (
    select is_active
    from public.portal_users
    where id = '23000000-0000-0000-0000-000000000005'
  ),
  true,
  'owner customer status change is persisted'
);

select * from finish();
rollback;
