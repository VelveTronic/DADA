begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(88);

-- Grants and policies: authenticated keeps legitimate reads but has no direct
-- company/customer write path. Every public management RPC is authenticated-
-- only; the private rank helper is not a client API at all.
select ok(
  not has_table_privilege('authenticated', 'public.companies', 'INSERT'),
  'authenticated cannot insert companies directly'
);
select ok(
  not has_table_privilege('authenticated', 'public.companies', 'UPDATE'),
  'authenticated cannot update companies directly'
);
select ok(
  not has_table_privilege('authenticated', 'public.companies', 'DELETE'),
  'authenticated cannot delete companies directly'
);
select ok(
  not has_table_privilege('authenticated', 'public.portal_users', 'INSERT'),
  'authenticated cannot insert portal users directly'
);
select ok(
  not has_table_privilege('authenticated', 'public.portal_users', 'UPDATE'),
  'authenticated cannot update portal users directly'
);
select ok(
  not has_table_privilege('authenticated', 'public.portal_users', 'DELETE'),
  'authenticated cannot delete portal users directly'
);
select ok(
  not exists (
    select 1
    from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename = 'companies'
      and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
  ),
  'companies have no authenticated write policy'
);
select ok(
  not exists (
    select 1
    from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename = 'portal_users'
      and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
  ),
  'portal users have no authenticated write policy'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'private.is_staff_at_least(text)',
    'EXECUTE'
  ),
  'authenticated cannot execute the private role helper'
);
select ok(
  not has_function_privilege(
    'service_role',
    'private.is_staff_at_least(text)',
    'EXECUTE'
  ),
  'service role cannot execute the private role helper'
);
select is(
  (
    select procedure.provolatile
    from pg_catalog.pg_proc as procedure
    where procedure.oid = 'private.is_staff_at_least(text)'::regprocedure
  ),
  'v'::"char",
  'role helper is volatile so the post-lock check receives a fresh snapshot'
);

select ok(
  (
    select pg_catalog.bool_and(
      has_function_privilege('authenticated', function_oid::oid, 'EXECUTE')
    )
    from pg_catalog.unnest(array[
      'public.staff_provision_customer(uuid,text,uuid,text,integer,smallint)'::regprocedure,
      'public.staff_provision_staff(uuid,text,text)'::regprocedure,
      'public.staff_set_customer_active(uuid,boolean)'::regprocedure,
      'public.staff_set_staff_active(uuid,boolean)'::regprocedure,
      'public.staff_set_staff_role(uuid,text)'::regprocedure,
      'public.update_own_display_name(text)'::regprocedure
    ]) as functions(function_oid)
  ),
  'authenticated can execute every fixed-shape administration RPC'
);
select ok(
  (
    select pg_catalog.bool_and(
      not has_function_privilege('anon', function_oid::oid, 'EXECUTE')
    )
    from pg_catalog.unnest(array[
      'public.staff_provision_customer(uuid,text,uuid,text,integer,smallint)'::regprocedure,
      'public.staff_provision_staff(uuid,text,text)'::regprocedure,
      'public.staff_set_customer_active(uuid,boolean)'::regprocedure,
      'public.staff_set_staff_active(uuid,boolean)'::regprocedure,
      'public.staff_set_staff_role(uuid,text)'::regprocedure,
      'public.update_own_display_name(text)'::regprocedure
    ]) as functions(function_oid)
  ),
  'anon cannot execute any administration RPC'
);
select ok(
  (
    select pg_catalog.bool_and(
      not has_function_privilege('service_role', function_oid::oid, 'EXECUTE')
    )
    from pg_catalog.unnest(array[
      'public.staff_provision_customer(uuid,text,uuid,text,integer,smallint)'::regprocedure,
      'public.staff_provision_staff(uuid,text,text)'::regprocedure,
      'public.staff_set_customer_active(uuid,boolean)'::regprocedure,
      'public.staff_set_staff_active(uuid,boolean)'::regprocedure,
      'public.staff_set_staff_role(uuid,text)'::regprocedure,
      'public.update_own_display_name(text)'::regprocedure
    ]) as functions(function_oid)
  ),
  'service role cannot execute any administration RPC'
);
select is(
  (
    select pg_catalog.count(*)
    from pg_catalog.unnest(array[
      'public.staff_provision_customer(uuid,text,uuid,text,integer,smallint)'::regprocedure,
      'public.staff_provision_staff(uuid,text,text)'::regprocedure,
      'public.staff_set_customer_active(uuid,boolean)'::regprocedure,
      'public.staff_set_staff_active(uuid,boolean)'::regprocedure,
      'public.staff_set_staff_role(uuid,text)'::regprocedure
    ]) as functions(function_oid)
    where pg_catalog.strpos(
      pg_catalog.pg_get_functiondef(function_oid::oid),
      'pg_advisory_xact_lock'
    ) > 0
      and pg_catalog.strpos(
        pg_catalog.pg_get_functiondef(function_oid::oid),
        'dada.staff-role-admin'
      ) > 0
  ),
  5::bigint,
  'all five staff management RPCs share the authorization advisory lock'
);
select is(
  (
    select pg_catalog.count(*)
    from pg_catalog.unnest(array[
      'public.staff_provision_customer(uuid,text,uuid,text,integer,smallint)'::regprocedure,
      'public.staff_provision_staff(uuid,text,text)'::regprocedure,
      'public.staff_set_customer_active(uuid,boolean)'::regprocedure,
      'public.staff_set_staff_active(uuid,boolean)'::regprocedure,
      'public.staff_set_staff_role(uuid,text)'::regprocedure
    ]) as functions(function_oid)
    cross join lateral (
      select pg_catalog.pg_get_functiondef(function_oid::oid) as definition
    ) as source
    where (
      (
        pg_catalog.length(source.definition)
        - pg_catalog.length(
          pg_catalog.replace(source.definition, 'private.is_staff_at_least', '')
        )
      ) / pg_catalog.length('private.is_staff_at_least')
    ) >= 2
  ),
  5::bigint,
  'all staff management RPCs recheck authorization after taking the lock'
);
select is(
  (
    select pg_catalog.count(*)
    from pg_catalog.pg_proc as procedure
    join pg_catalog.unnest(array[
      'private.is_staff_at_least(text)'::regprocedure,
      'public.staff_provision_customer(uuid,text,uuid,text,integer,smallint)'::regprocedure,
      'public.staff_provision_staff(uuid,text,text)'::regprocedure,
      'public.staff_set_customer_active(uuid,boolean)'::regprocedure,
      'public.staff_set_staff_active(uuid,boolean)'::regprocedure,
      'public.staff_set_staff_role(uuid,text)'::regprocedure,
      'public.update_own_display_name(text)'::regprocedure
    ]) as functions(function_oid)
      on procedure.oid = function_oid::oid
    where procedure.prosecdef
  ),
  7::bigint,
  'all seven authorization functions are security definers'
);
select is(
  (
    select pg_catalog.count(*)
    from pg_catalog.pg_proc as procedure
    join pg_catalog.unnest(array[
      'private.is_staff_at_least(text)'::regprocedure,
      'public.staff_provision_customer(uuid,text,uuid,text,integer,smallint)'::regprocedure,
      'public.staff_provision_staff(uuid,text,text)'::regprocedure,
      'public.staff_set_customer_active(uuid,boolean)'::regprocedure,
      'public.staff_set_staff_active(uuid,boolean)'::regprocedure,
      'public.staff_set_staff_role(uuid,text)'::regprocedure,
      'public.update_own_display_name(text)'::regprocedure
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
  7::bigint,
  'all seven authorization functions pin an empty search path'
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
    ('20000000-0000-0000-0000-000000000001'::uuid, 'role-owner@example.invalid'),
    ('20000000-0000-0000-0000-000000000002'::uuid, 'role-manager@example.invalid'),
    ('20000000-0000-0000-0000-000000000003'::uuid, 'role-staff@example.invalid'),
    ('20000000-0000-0000-0000-000000000004'::uuid, 'role-inactive-owner@example.invalid'),
    ('20000000-0000-0000-0000-000000000005'::uuid, 'role-customer-one@example.invalid'),
    ('20000000-0000-0000-0000-000000000006'::uuid, 'role-customer-two@example.invalid'),
    ('20000000-0000-0000-0000-000000000007'::uuid, 'role-inactive-customer@example.invalid'),
    ('20000000-0000-0000-0000-000000000008'::uuid, 'role-unknown@example.invalid'),
    ('20000000-0000-0000-0000-000000000009'::uuid, 'role-new-existing-customer@example.invalid'),
    ('20000000-0000-0000-0000-000000000010'::uuid, 'role-new-company-customer@example.invalid'),
    ('20000000-0000-0000-0000-000000000011'::uuid, 'role-new-staff@example.invalid'),
    ('20000000-0000-0000-0000-000000000012'::uuid, 'role-validation-target@example.invalid'),
    ('20000000-0000-0000-0000-000000000013'::uuid, 'role-conflict-staff@example.invalid'),
    ('20000000-0000-0000-0000-000000000014'::uuid, 'role-inactive-company-target@example.invalid'),
    ('20000000-0000-0000-0000-000000000015'::uuid, 'role-inactive-company-customer@example.invalid')
) as fixture(id, email);

insert into public.companies (id, codcli, name, tarcli, is_active)
values
(
  '20000000-0000-0000-0000-000000000101',
  910001,
  'Role Active Company',
  1,
  true
),
(
  '20000000-0000-0000-0000-000000000102',
  910002,
  'Role Inactive Company',
  2,
  false
);

insert into public.staff_users (id, role, display_name, is_active)
values
('20000000-0000-0000-0000-000000000001', 'owner', 'Owner', true),
('20000000-0000-0000-0000-000000000002', 'manager', 'Manager', true),
('20000000-0000-0000-0000-000000000003', 'staff', 'Staff', true),
('20000000-0000-0000-0000-000000000004', 'owner', 'Inactive Owner', false),
('20000000-0000-0000-0000-000000000013', 'staff', 'Conflict Staff', true);

insert into public.portal_users (
  id, company_id, display_name, is_active
)
values
(
  '20000000-0000-0000-0000-000000000005',
  '20000000-0000-0000-0000-000000000101',
  'Customer One',
  true
),
(
  '20000000-0000-0000-0000-000000000006',
  '20000000-0000-0000-0000-000000000101',
  'Customer Two',
  true
),
(
  '20000000-0000-0000-0000-000000000007',
  '20000000-0000-0000-0000-000000000101',
  'Inactive Customer',
  false
),
(
  '20000000-0000-0000-0000-000000000015',
  '20000000-0000-0000-0000-000000000102',
  'Inactive Company Customer',
  true
);

-- The absence of DML grants is effective for every application role, not just
-- a catalog assertion. Each JWT below reaches a row it could legitimately read
-- and is still rejected before RLS could become the sole defense.
set local role authenticated;

select set_config(
  'request.jwt.claims',
  '{"sub":"20000000-0000-0000-0000-000000000005","role":"authenticated"}',
  true
);
select throws_ok(
  $$update public.companies set name = name
    where id = '20000000-0000-0000-0000-000000000101'$$,
  '42501',
  'permission denied for table companies',
  'customer cannot update companies directly'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"20000000-0000-0000-0000-000000000003","role":"authenticated"}',
  true
);
select throws_ok(
  $$update public.companies set name = name
    where id = '20000000-0000-0000-0000-000000000101'$$,
  '42501',
  'permission denied for table companies',
  'staff cannot update companies directly'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"20000000-0000-0000-0000-000000000002","role":"authenticated"}',
  true
);
select throws_ok(
  $$update public.companies set name = name
    where id = '20000000-0000-0000-0000-000000000101'$$,
  '42501',
  'permission denied for table companies',
  'manager cannot update companies directly'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"20000000-0000-0000-0000-000000000001","role":"authenticated"}',
  true
);
select throws_ok(
  $$update public.companies set name = name
    where id = '20000000-0000-0000-0000-000000000101'$$,
  '42501',
  'permission denied for table companies',
  'owner cannot update companies directly'
);
select throws_ok(
  $$insert into public.portal_users (id, company_id)
    values (
      '20000000-0000-0000-0000-000000000012',
      '20000000-0000-0000-0000-000000000101'
    )$$,
  '42501',
  'permission denied for table portal_users',
  'owner cannot insert portal users directly'
);
select throws_ok(
  $$delete from public.portal_users
    where id = '20000000-0000-0000-0000-000000000006'$$,
  '42501',
  'permission denied for table portal_users',
  'owner cannot delete portal users directly'
);

reset role;

-- Role rank helper matrix, exercised as the migration owner because clients do
-- not have EXECUTE. Unknown requirements and inactive/non-staff callers fail
-- closed.
select set_config(
  'request.jwt.claims',
  '{"sub":"20000000-0000-0000-0000-000000000001","role":"authenticated"}',
  true
);
select is(private.is_staff_at_least('owner'), true, 'owner meets owner floor');

select set_config(
  'request.jwt.claims',
  '{"sub":"20000000-0000-0000-0000-000000000002","role":"authenticated"}',
  true
);
select is(private.is_staff_at_least('manager'), true, 'manager meets manager floor');
select is(private.is_staff_at_least('owner'), false, 'manager does not meet owner floor');

select set_config(
  'request.jwt.claims',
  '{"sub":"20000000-0000-0000-0000-000000000003","role":"authenticated"}',
  true
);
select is(private.is_staff_at_least('staff'), true, 'staff meets staff floor');
select is(private.is_staff_at_least('manager'), false, 'staff does not meet manager floor');
select is(private.is_staff_at_least('superuser'), false, 'unknown role floor fails closed');

select set_config(
  'request.jwt.claims',
  '{"sub":"20000000-0000-0000-0000-000000000005","role":"authenticated"}',
  true
);
select is(private.is_staff_at_least('staff'), false, 'customer is not staff');

select set_config(
  'request.jwt.claims',
  '{"sub":"20000000-0000-0000-0000-000000000004","role":"authenticated"}',
  true
);
select is(private.is_staff_at_least('owner'), false, 'inactive owner is not authorized');

set local role authenticated;

-- Customer provisioning authorization matrix.
select set_config(
  'request.jwt.claims',
  '{"sub":"20000000-0000-0000-0000-000000000003","role":"authenticated"}',
  true
);
select throws_ok(
  $$select public.staff_provision_customer(
      '20000000-0000-0000-0000-000000000009',
      'Denied Customer',
      '20000000-0000-0000-0000-000000000101',
      null, null, null
    )$$,
  '42501',
  'MANAGER_ONLY',
  'plain staff cannot provision customers'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"20000000-0000-0000-0000-000000000005","role":"authenticated"}',
  true
);
select throws_ok(
  $$select public.staff_provision_customer(
      '20000000-0000-0000-0000-000000000009',
      'Denied Customer',
      '20000000-0000-0000-0000-000000000101',
      null, null, null
    )$$,
  '42501',
  'MANAGER_ONLY',
  'customer cannot provision customers'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"20000000-0000-0000-0000-000000000004","role":"authenticated"}',
  true
);
select throws_ok(
  $$select public.staff_provision_customer(
      '20000000-0000-0000-0000-000000000009',
      'Denied Customer',
      '20000000-0000-0000-0000-000000000101',
      null, null, null
    )$$,
  '42501',
  'MANAGER_ONLY',
  'inactive owner cannot provision customers'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"20000000-0000-0000-0000-000000000008","role":"authenticated"}',
  true
);
select throws_ok(
  $$select public.staff_provision_customer(
      '20000000-0000-0000-0000-000000000009',
      'Denied Customer',
      '20000000-0000-0000-0000-000000000101',
      null, null, null
    )$$,
  '42501',
  'MANAGER_ONLY',
  'unknown authenticated user cannot provision customers'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"20000000-0000-0000-0000-000000000002","role":"authenticated"}',
  true
);
select is(
  public.staff_provision_customer(
    '20000000-0000-0000-0000-000000000009',
    '  Existing Customer  ',
    '20000000-0000-0000-0000-000000000101',
    null, null, null
  ),
  '20000000-0000-0000-0000-000000000101'::uuid,
  'manager provisions a customer into an active existing company'
);
select ok(
  (
    select company_id = '20000000-0000-0000-0000-000000000101'
      and display_name = 'Existing Customer'
      and is_active
    from public.portal_users
    where id = '20000000-0000-0000-0000-000000000009'
  ),
  'existing-company provisioning stores the normalized profile atomically'
);
select throws_ok(
  $$select public.staff_provision_customer(
      '20000000-0000-0000-0000-000000000014',
      'Inactive Company Target',
      '20000000-0000-0000-0000-000000000102',
      null, null, null
    )$$,
  '22023',
  'BAD_COMPANY',
  'customer cannot be provisioned into an inactive company'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"20000000-0000-0000-0000-000000000001","role":"authenticated"}',
  true
);
select ok(
  public.staff_provision_customer(
    '20000000-0000-0000-0000-000000000010',
    '  New Company Customer  ',
    null,
    '  New Atomic Company  ',
    910010,
    3::smallint
  ) is not null,
  'owner provisions a customer with a new company'
);
select ok(
  exists (
    select 1
    from public.portal_users as portal
    join public.companies as company on company.id = portal.company_id
    where portal.id = '20000000-0000-0000-0000-000000000010'
      and portal.display_name = 'New Company Customer'
      and company.name = 'New Atomic Company'
      and company.codcli = 910010
      and company.tarcli = 3
      and company.is_active
  ),
  'new company and portal profile commit together with normalized values'
);

select throws_ok(
  $$select public.staff_provision_customer(
      '20000000-0000-0000-0000-000000000012',
      'Both Branches',
      '20000000-0000-0000-0000-000000000101',
      'Unexpected New Company',
      910012,
      2::smallint
    )$$,
  '22023',
  'BAD_COMPANY',
  'existing and new company inputs cannot be combined'
);
select throws_ok(
  $$select public.staff_provision_customer(
      '20000000-0000-0000-0000-000000000012',
      'Neither Branch',
      null, null, null, null
    )$$,
  '22023',
  'BAD_COMPANY',
  'a customer provision requires exactly one company branch'
);
select throws_ok(
  $$select public.staff_provision_customer(
      '20000000-0000-0000-0000-000000000012',
      '   ',
      '20000000-0000-0000-0000-000000000101',
      null, null, null
    )$$,
  '22023',
  'BAD_NAME',
  'customer display name cannot be blank'
);
select throws_ok(
  $$select public.staff_provision_customer(
      '20000000-0000-0000-0000-000000000012',
      repeat('n', 81),
      '20000000-0000-0000-0000-000000000101',
      null, null, null
    )$$,
  '22023',
  'BAD_NAME',
  'customer display name is capped at eighty characters'
);
select throws_ok(
  $$select public.staff_provision_customer(
      '20000000-0000-0000-0000-000000000012',
      'Bad Company Name',
      null,
      '   ',
      910012,
      2::smallint
    )$$,
  '22023',
  'BAD_COMPANY',
  'new company name cannot be blank'
);
select throws_ok(
  $$select public.staff_provision_customer(
      '20000000-0000-0000-0000-000000000012',
      'Bad Codcli',
      null,
      'Bad Codcli Company',
      0,
      2::smallint
    )$$,
  '22023',
  'BAD_CODCLI',
  'new company codcli must be positive'
);
select throws_ok(
  $$select public.staff_provision_customer(
      '20000000-0000-0000-0000-000000000012',
      'Bad Tarcli',
      null,
      'Bad Tarcli Company',
      910012,
      7::smallint
    )$$,
  '22023',
  'BAD_TARCLI',
  'new company tariff must be between one and six'
);

select throws_ok(
  $$select public.staff_provision_customer(
      '20000000-0000-0000-0000-000000000013',
      'Conflicting Customer',
      null,
      'Must Roll Back',
      919999,
      4::smallint
    )$$,
  '23505',
  'USER_ROLE_CONFLICT',
  'a staff auth id cannot also receive a customer profile'
);
select is(
  (
    select pg_catalog.count(*)
    from public.companies
    where codcli = 919999
  ),
  0::bigint,
  'failed portal insertion rolls the new company back'
);

-- Staff provisioning remains owner-only and preserves role exclusivity.
select set_config(
  'request.jwt.claims',
  '{"sub":"20000000-0000-0000-0000-000000000002","role":"authenticated"}',
  true
);
select throws_ok(
  $$select public.staff_provision_staff(
      '20000000-0000-0000-0000-000000000011',
      'Denied Staff',
      'staff'
    )$$,
  '42501',
  'OWNER_ONLY',
  'manager cannot provision staff'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"20000000-0000-0000-0000-000000000005","role":"authenticated"}',
  true
);
select throws_ok(
  $$select public.staff_provision_staff(
      '20000000-0000-0000-0000-000000000011',
      'Denied Staff',
      'staff'
    )$$,
  '42501',
  'OWNER_ONLY',
  'customer cannot provision staff'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"20000000-0000-0000-0000-000000000004","role":"authenticated"}',
  true
);
select throws_ok(
  $$select public.staff_provision_staff(
      '20000000-0000-0000-0000-000000000011',
      'Denied Staff',
      'staff'
    )$$,
  '42501',
  'OWNER_ONLY',
  'inactive owner cannot provision staff'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"20000000-0000-0000-0000-000000000001","role":"authenticated"}',
  true
);
select throws_ok(
  $$select public.staff_provision_staff(
      '20000000-0000-0000-0000-000000000011',
      'Bad Role Staff',
      'admin'
    )$$,
  '22023',
  'BAD_ROLE',
  'staff role must be one of the three known values'
);
select throws_ok(
  $$select public.staff_provision_staff(
      '20000000-0000-0000-0000-000000000011',
      repeat('n', 81),
      'staff'
    )$$,
  '22023',
  'BAD_NAME',
  'staff display name is capped at eighty characters'
);
select is(
  public.staff_provision_staff(
    '20000000-0000-0000-0000-000000000011',
    '  New Manager  ',
    'manager'
  ),
  true,
  'owner provisions a staff profile'
);
reset role;
select ok(
  (
    select display_name = 'New Manager' and role = 'manager' and is_active
    from public.staff_users
    where id = '20000000-0000-0000-0000-000000000011'
  ),
  'staff provisioning stores normalized name, role, and active state'
);
set local role authenticated;
select throws_ok(
  $$select public.staff_provision_staff(
      '20000000-0000-0000-0000-000000000006',
      'Conflicting Staff',
      'staff'
    )$$,
  '23505',
  'USER_ROLE_CONFLICT',
  'a customer auth id cannot also receive a staff profile'
);

-- Customer activation is manager+, staff activation/role are owner-only, and
-- missing targets report false rather than a misleading success.
select set_config(
  'request.jwt.claims',
  '{"sub":"20000000-0000-0000-0000-000000000003","role":"authenticated"}',
  true
);
select throws_ok(
  $$select public.staff_set_customer_active(
      '20000000-0000-0000-0000-000000000009',
      false
    )$$,
  '42501',
  'MANAGER_ONLY',
  'plain staff cannot change customer active state'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"20000000-0000-0000-0000-000000000005","role":"authenticated"}',
  true
);
select throws_ok(
  $$select public.staff_set_customer_active(
      '20000000-0000-0000-0000-000000000009',
      false
    )$$,
  '42501',
  'MANAGER_ONLY',
  'customer cannot change another customer active state'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"20000000-0000-0000-0000-000000000002","role":"authenticated"}',
  true
);
select is(
  public.staff_set_customer_active(
    '20000000-0000-0000-0000-000000000008',
    false
  ),
  false,
  'customer active setter reports a missing profile'
);
select is(
  public.staff_set_customer_active(
    '20000000-0000-0000-0000-000000000009',
    false
  ),
  true,
  'manager deactivates a customer'
);
select is(
  (
    select is_active
    from public.portal_users
    where id = '20000000-0000-0000-0000-000000000009'
  ),
  false,
  'customer deactivation is persisted'
);
select throws_ok(
  $$select public.staff_set_customer_active(
      '20000000-0000-0000-0000-000000000009',
      null
    )$$,
  '22023',
  'BAD_ACTIVE',
  'customer active flag cannot be null'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"20000000-0000-0000-0000-000000000001","role":"authenticated"}',
  true
);
select is(
  public.staff_set_customer_active(
    '20000000-0000-0000-0000-000000000009',
    true
  ),
  true,
  'owner may reactivate a customer'
);
select throws_ok(
  $$select public.staff_set_staff_active(
      '20000000-0000-0000-0000-000000000001',
      false
    )$$,
  '42501',
  'SELF_FORBIDDEN',
  'owner cannot deactivate their own staff profile'
);
select throws_ok(
  $$select public.staff_set_staff_role(
      '20000000-0000-0000-0000-000000000001',
      'staff'
    )$$,
  '42501',
  'SELF_FORBIDDEN',
  'owner cannot change their own role'
);
select is(
  public.staff_set_staff_active(
    '20000000-0000-0000-0000-000000000008',
    false
  ),
  false,
  'staff active setter reports a missing profile'
);
select is(
  public.staff_set_staff_role(
    '20000000-0000-0000-0000-000000000008',
    'manager'
  ),
  false,
  'staff role setter reports a missing profile'
);
select throws_ok(
  $$select public.staff_set_staff_role(
      '20000000-0000-0000-0000-000000000013',
      'admin'
    )$$,
  '22023',
  'BAD_ROLE',
  'staff role setter rejects unknown roles'
);
select is(
  public.staff_set_staff_role(
    '20000000-0000-0000-0000-000000000013',
    'manager'
  ),
  true,
  'owner promotes another staff member'
);
reset role;
select is(
  (
    select role
    from public.staff_users
    where id = '20000000-0000-0000-0000-000000000013'
  ),
  'manager',
  'staff role change is persisted'
);
set local role authenticated;
select is(
  public.staff_set_staff_active(
    '20000000-0000-0000-0000-000000000011',
    false
  ),
  true,
  'owner deactivates another staff user'
);
reset role;
select is(
  (
    select is_active
    from public.staff_users
    where id = '20000000-0000-0000-0000-000000000011'
  ),
  false,
  'staff deactivation is persisted'
);
set local role authenticated;

select set_config(
  'request.jwt.claims',
  '{"sub":"20000000-0000-0000-0000-000000000002","role":"authenticated"}',
  true
);
select throws_ok(
  $$select public.staff_set_staff_active(
      '20000000-0000-0000-0000-000000000013',
      false
    )$$,
  '42501',
  'OWNER_ONLY',
  'manager cannot deactivate staff'
);
select throws_ok(
  $$select public.staff_set_staff_role(
      '20000000-0000-0000-0000-000000000013',
      'staff'
    )$$,
  '42501',
  'OWNER_ONLY',
  'manager cannot change staff roles'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"20000000-0000-0000-0000-000000000004","role":"authenticated"}',
  true
);
select throws_ok(
  $$select public.staff_set_staff_active(
      '20000000-0000-0000-0000-000000000013',
      false
    )$$,
  '42501',
  'OWNER_ONLY',
  'inactive owner cannot manage staff active state'
);

-- Self-service has no target parameter and applies only to an active customer
-- whose company is also active. Staff, unknown, and inactive identities update
-- no row even though they hold the authenticated Postgres role.
select set_config(
  'request.jwt.claims',
  '{"sub":"20000000-0000-0000-0000-000000000005","role":"authenticated"}',
  true
);
select is(
  public.update_own_display_name('  Customer One Renamed  '),
  true,
  'active customer updates their own display name'
);
reset role;
select ok(
  (
    select pg_catalog.bool_and(
      case id
        when '20000000-0000-0000-0000-000000000005'::uuid
          then display_name = 'Customer One Renamed'
        when '20000000-0000-0000-0000-000000000006'::uuid
          then display_name = 'Customer Two'
        else false
      end
    )
    from public.portal_users
    where id in (
      '20000000-0000-0000-0000-000000000005',
      '20000000-0000-0000-0000-000000000006'
    )
  ),
  'self-service changes only auth.uid() and trims the name'
);
set local role authenticated;
select throws_ok(
  $$select public.update_own_display_name('   ')$$,
  '22023',
  'BAD_NAME',
  'own display name cannot be blank'
);
select throws_ok(
  $$select public.update_own_display_name(repeat('n', 81))$$,
  '22023',
  'BAD_NAME',
  'own display name is capped at eighty characters'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"20000000-0000-0000-0000-000000000003","role":"authenticated"}',
  true
);
select is(
  public.update_own_display_name('Staff Cannot Use Customer Profile RPC'),
  false,
  'staff profile is not a customer self-service target'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"20000000-0000-0000-0000-000000000002","role":"authenticated"}',
  true
);
select is(
  public.update_own_display_name('Manager Cannot Use Customer Profile RPC'),
  false,
  'manager profile is not a customer self-service target'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"20000000-0000-0000-0000-000000000001","role":"authenticated"}',
  true
);
select is(
  public.update_own_display_name('Owner Cannot Use Customer Profile RPC'),
  false,
  'owner profile is not a customer self-service target'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"20000000-0000-0000-0000-000000000008","role":"authenticated"}',
  true
);
select is(
  public.update_own_display_name('Unknown Cannot Update'),
  false,
  'unknown authenticated user has no self-service target'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"20000000-0000-0000-0000-000000000007","role":"authenticated"}',
  true
);
select is(
  public.update_own_display_name('Inactive Cannot Update'),
  false,
  'inactive customer cannot update their display name'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"20000000-0000-0000-0000-000000000015","role":"authenticated"}',
  true
);
select is(
  public.update_own_display_name('Inactive Company Cannot Update'),
  false,
  'customer of an inactive company cannot update their display name'
);
select is(
  (
    select display_name
    from public.portal_users
    where id = '20000000-0000-0000-0000-000000000015'
  ),
  'Inactive Company Customer',
  'inactive-company self-service leaves the stored name unchanged'
);

reset role;
select * from finish();
rollback;
