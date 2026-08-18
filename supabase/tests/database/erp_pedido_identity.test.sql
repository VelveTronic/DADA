begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(55);

-- Schema and ACL contract. Authenticated users may read the namespace through
-- the existing row policy, but only the bridge may attach it to an order.
select is(
  (
    select data_type
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'orders'
      and column_name = 'erp_can'
  ),
  'text',
  'ERP CAN is stored as text'
);
select is(
  (
    select data_type
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'orders'
      and column_name = 'erp_eje'
  ),
  'integer',
  'ERP EJE is stored as an integer'
);
select ok(
  (
    select is_nullable = 'YES'
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'orders'
      and column_name = 'erp_can'
  ),
  'ERP CAN remains nullable during historical validation'
);
select is(
  (
    select data_type
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'orders'
      and column_name = 'albaran_can'
  ),
  'text',
  'Albarán CAN is stored separately as text'
);
select is(
  (
    select data_type
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'orders'
      and column_name = 'albaran_eje'
  ),
  'integer',
  'Albarán EJE is stored separately as an integer'
);
select ok(
  (
    select index_meta.indisunique
      and index_meta.indpred is not null
      and pg_catalog.strpos(
        pg_catalog.pg_get_indexdef(index_meta.indexrelid),
        '(erp_can, erp_eje, numped)'
      ) > 0
    from pg_catalog.pg_index as index_meta
    where index_meta.indexrelid =
      'public.orders_erp_pedido_identity'::regclass
  ),
  'ERP pedido identity has a partial unique three-column index'
);
select ok(
  to_regprocedure('public.bridge_mark_injected(uuid,uuid,integer)') is null,
  'the NUMPED-only bridge RPC no longer exists'
);
select ok(
  to_regprocedure(
    'public.bridge_mark_injected(uuid,uuid,text,integer,integer)'
  ) is not null,
  'the bridge RPC requires CAN, EJE and NUMPED'
);
select ok(
  has_column_privilege(
    'authenticated', 'public.orders', 'erp_can', 'SELECT'
  ),
  'authenticated may select ERP CAN subject to orders RLS'
);
select ok(
  has_column_privilege(
    'authenticated', 'public.orders', 'erp_eje', 'SELECT'
  ),
  'authenticated may select ERP EJE subject to orders RLS'
);
select ok(
  has_column_privilege(
    'authenticated', 'public.orders', 'albaran_can', 'SELECT'
  ),
  'authenticated may select Albarán CAN subject to orders RLS'
);
select ok(
  has_column_privilege(
    'authenticated', 'public.orders', 'albaran_eje', 'SELECT'
  ),
  'authenticated may select Albarán EJE subject to orders RLS'
);
select ok(
  not has_column_privilege('anon', 'public.orders', 'erp_can', 'SELECT'),
  'anon cannot select ERP CAN'
);
select ok(
  not has_column_privilege('anon', 'public.orders', 'erp_eje', 'SELECT'),
  'anon cannot select ERP EJE'
);
select ok(
  not has_column_privilege('anon', 'public.orders', 'albaran_can', 'SELECT'),
  'anon cannot select Albarán CAN'
);
select ok(
  not has_column_privilege('anon', 'public.orders', 'albaran_eje', 'SELECT'),
  'anon cannot select Albarán EJE'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.bridge_mark_injected(uuid,uuid,text,integer,integer)',
    'EXECUTE'
  ),
  'authenticated cannot attach an ERP identity'
);
select ok(
  not has_function_privilege(
    'anon',
    'public.bridge_mark_injected(uuid,uuid,text,integer,integer)',
    'EXECUTE'
  ),
  'anon cannot attach an ERP identity'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.bridge_mark_injected(uuid,uuid,text,integer,integer)',
    'EXECUTE'
  ),
  'service role can attach an ERP identity'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.bridge_backfill_order_identity(uuid,text,integer,integer)',
    'EXECUTE'
  ),
  'service role can backfill a verified historical ERP identity'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.bridge_backfill_order_identity(uuid,text,integer,integer)',
    'EXECUTE'
  ),
  'authenticated cannot backfill an ERP identity'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.bridge_mark_albaran(uuid,text,integer,integer)',
    'EXECUTE'
  ),
  'service role can attach an independent Albarán identity'
);
select ok(
  not exists (
    select 1
    from pg_catalog.pg_proc as procedure
    cross join lateral pg_catalog.aclexplode(procedure.proacl) as acl
    where procedure.oid =
      'public.bridge_mark_injected(uuid,uuid,text,integer,integer)'::regprocedure
      and acl.grantee = 0
      and acl.privilege_type = 'EXECUTE'
  ),
  'PUBLIC has no implicit execute grant on the bridge RPC'
);
select ok(
  (
    select procedure.prosecdef
    from pg_catalog.pg_proc as procedure
    where procedure.oid =
      'public.bridge_mark_injected(uuid,uuid,text,integer,integer)'::regprocedure
  ),
  'the bridge RPC is a security definer'
);
select ok(
  (
    select exists (
      select 1
      from pg_catalog.unnest(procedure.proconfig) as settings(setting)
      where pg_catalog.split_part(settings.setting, '=', 1) = 'search_path'
        and pg_catalog.replace(
          pg_catalog.split_part(settings.setting, '=', 2),
          '"',
          ''
        ) = ''
    )
    from pg_catalog.pg_proc as procedure
    where procedure.oid =
      'public.bridge_mark_injected(uuid,uuid,text,integer,integer)'::regprocedure
  ),
  'the bridge RPC pins an empty search path'
);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
  '30000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'erp-customer@example.invalid', '',
  pg_catalog.now(), '{}'::jsonb, '{}'::jsonb,
  pg_catalog.now(), pg_catalog.now()
);

insert into public.companies (id, codcli, name, tarcli)
values
(
  '30000000-0000-0000-0000-000000000002',
  900020,
  'ERP Identity Customer',
  1
),
(
  '30000000-0000-0000-0000-000000000003',
  900021,
  'Other ERP Customer',
  1
);

insert into public.portal_users (id, company_id, display_name)
values (
  '30000000-0000-0000-0000-000000000001',
  '30000000-0000-0000-0000-000000000002',
  'ERP Customer'
);

insert into public.orders (
  id,
  company_id,
  status,
  confirmed_at,
  bridge_claim_token,
  bridge_claimed_at,
  bridge_attempt_count,
  bridge_last_error_code,
  bridge_failed_at
) values
(
  '30000000-0000-0000-0000-000000000010',
  '30000000-0000-0000-0000-000000000002',
  'processing',
  pg_catalog.now(),
  '30000000-0000-0000-0000-000000000020',
  pg_catalog.now(),
  1,
  'PREVIOUS_TRANSIENT',
  pg_catalog.now()
),
(
  '30000000-0000-0000-0000-000000000011',
  '30000000-0000-0000-0000-000000000002',
  'processing',
  pg_catalog.now(),
  '30000000-0000-0000-0000-000000000021',
  pg_catalog.now(),
  1,
  null,
  null
),
(
  '30000000-0000-0000-0000-000000000012',
  '30000000-0000-0000-0000-000000000002',
  'processing',
  pg_catalog.now(),
  '30000000-0000-0000-0000-000000000022',
  pg_catalog.now(),
  1,
  null,
  null
),
(
  '30000000-0000-0000-0000-000000000013',
  '30000000-0000-0000-0000-000000000002',
  'confirmed',
  pg_catalog.now(),
  null,
  null,
  0,
  null,
  null
);

insert into public.orders (
  id, company_id, status, confirmed_at,
  erp_can, erp_eje, numped, injected_at
) values (
  '30000000-0000-0000-0000-000000000014',
  '30000000-0000-0000-0000-000000000003',
  'injected',
  pg_catalog.now(),
  'A',
  26,
  70002,
  pg_catalog.now()
);
insert into public.orders (
  id, company_id, status, confirmed_at,
  numped, injected_at
) values (
  '30000000-0000-0000-0000-000000000015',
  '30000000-0000-0000-0000-000000000003',
  'injected',
  pg_catalog.now(),
  70003,
  pg_catalog.now()
);

set local role service_role;

select is(
  public.bridge_backfill_order_identity(
    '30000000-0000-0000-0000-000000000015',
    'a',
    25,
    70003
  ),
  true,
  'the bridge can backfill a verified historical CAN/EJE without guessing'
);
select is(
  (
    select erp_can || '/' || erp_eje::text
    from public.orders
    where id = '30000000-0000-0000-0000-000000000015'
  ),
  'A/25',
  'historical backfill stores the ERP identity returned by Wingest'
);

select is(
  public.bridge_mark_injected(
    '30000000-0000-0000-0000-000000000010',
    '30000000-0000-0000-0000-000000000099',
    'B',
    26,
    70001
  ),
  false,
  'a mismatched token cannot attach an ERP identity'
);
select ok(
  (
    select status = 'processing'
      and erp_can is null
      and erp_eje is null
      and numped is null
      and injected_at is null
      and bridge_claim_token = '30000000-0000-0000-0000-000000000020'
    from public.orders
    where id = '30000000-0000-0000-0000-000000000010'
  ),
  'a stale token leaves every identity field untouched'
);
select is(
  public.bridge_mark_injected(
    '30000000-0000-0000-0000-000000000012',
    '30000000-0000-0000-0000-000000000022',
    '   ',
    26,
    70003
  ),
  false,
  'a blank CAN is rejected before mutation'
);
select is(
  public.bridge_mark_injected(
    '30000000-0000-0000-0000-000000000012',
    '30000000-0000-0000-0000-000000000022',
    'B',
    0,
    70003
  ),
  false,
  'an out-of-range EJE is rejected before mutation'
);
select is(
  public.bridge_mark_injected(
    '30000000-0000-0000-0000-000000000010',
    '30000000-0000-0000-0000-000000000020',
    ' b ',
    26,
    70001
  ),
  true,
  'the matching token atomically writes the complete ERP identity'
);
select ok(
  (
    select status = 'injected'
      and erp_can = 'B'
      and erp_eje = 26
      and numped = 70001
      and injected_at is not null
      and bridge_claim_token is null
      and bridge_claimed_at is null
      and bridge_attempt_count = 0
      and bridge_last_error_code is null
      and bridge_failed_at is null
    from public.orders
    where id = '30000000-0000-0000-0000-000000000010'
  ),
  'lowercase CAN is normalized and successful injection clears the failure cycle'
);
select is(
  (
    select detail
    from public.order_events
    where order_id = '30000000-0000-0000-0000-000000000010'
      and event = 'injected'
  ),
  '{"can":"B","eje":26,"numped":70001}'::jsonb,
  'the injection event records the complete ERP identity'
);
select throws_ok(
  $$select public.bridge_mark_injected(
      '30000000-0000-0000-0000-000000000011',
      '30000000-0000-0000-0000-000000000021',
      'B',
      26,
      70001
    )$$,
  '23505',
  null,
  'the same CAN/EJE/NUMPED cannot identify two orders'
);
select ok(
  (
    select status = 'processing'
      and erp_can is null
      and erp_eje is null
      and numped is null
      and injected_at is null
      and bridge_claim_token = '30000000-0000-0000-0000-000000000021'
    from public.orders
    where id = '30000000-0000-0000-0000-000000000011'
  ),
  'a duplicate identity rolls back the whole state transition'
);
select is(
  public.bridge_mark_injected(
    '30000000-0000-0000-0000-000000000011',
    '30000000-0000-0000-0000-000000000021',
    'B',
    27,
    70001
  ),
  true,
  'the same NUMPED is valid in a different fiscal year'
);
select is(
  (
    select pg_catalog.count(*)
    from public.orders
    where erp_can = 'B'
      and numped = 70001
      and erp_eje in (26, 27)
  ),
  2::bigint,
  'both yearly identities coexist without ambiguity'
);
select is(
  public.bridge_mark_albaran(
    '30000000-0000-0000-0000-000000000010',
    'B',
    27,
    80001
  ),
  true,
  'an injected order can advance to albaran'
);
select ok(
  (
    select status = 'albaran'
      and erp_can = 'B'
      and erp_eje = 26
      and numped = 70001
      and albaran_can = 'B'
      and albaran_eje = 27
      and numalb = 80001
      and injected_at is not null
    from public.orders
    where id = '30000000-0000-0000-0000-000000000010'
  ),
  'the albaran transition preserves the complete pedido identity'
);

select throws_ok(
  $$update public.orders
    set status = 'injected',
        erp_can = 'B',
        numped = 90001,
        injected_at = pg_catalog.now()
    where id = '30000000-0000-0000-0000-000000000013'$$,
  '23514',
  null,
  'an injected order cannot omit EJE'
);
select throws_ok(
  $$update public.orders
    set erp_can = 'B'
    where id = '30000000-0000-0000-0000-000000000013'$$,
  '23514',
  null,
  'a non-linked order cannot carry a partial ERP identity'
);
select throws_ok(
  $$update public.orders
    set erp_can = ''
    where id = '30000000-0000-0000-0000-000000000011'$$,
  '23514',
  null,
  'stored CAN cannot be blank'
);
select throws_ok(
  $$update public.orders
    set erp_can = 'ABC'
    where id = '30000000-0000-0000-0000-000000000011'$$,
  '23514',
  null,
  'stored CAN cannot exceed two characters'
);
select throws_ok(
  $$update public.orders
    set erp_can = ' B'
    where id = '30000000-0000-0000-0000-000000000011'$$,
  '23514',
  null,
  'stored CAN must already be trimmed'
);
select throws_ok(
  $$update public.orders
    set erp_can = 'b'
    where id = '30000000-0000-0000-0000-000000000011'$$,
  '23514',
  null,
  'stored CAN must be uppercase so the unique index is case-stable'
);
select throws_ok(
  $$update public.orders
    set erp_eje = 0
    where id = '30000000-0000-0000-0000-000000000011'$$,
  '23514',
  null,
  'stored EJE must be positive'
);
select throws_ok(
  $$update public.orders
    set erp_eje = 10000
    where id = '30000000-0000-0000-0000-000000000011'$$,
  '23514',
  null,
  'stored EJE cannot exceed four digits'
);
select ok(
  not exists (
    select 1
    from public.orders
    where status in ('injected', 'albaran')
      and (
        erp_can is null
        or erp_eje is null
        or numped is null
        or injected_at is null
      )
  ),
  'every linked state has a complete ERP pedido identity'
);
select ok(
  not exists (
    select 1
    from public.orders
    where status not in ('injected', 'albaran')
      and (
        erp_can is not null
        or erp_eje is not null
        or numped is not null
        or injected_at is not null
      )
  ),
  'every non-linked state keeps all ERP pedido identity fields null'
);

reset role;
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"30000000-0000-0000-0000-000000000001","role":"authenticated"}',
  true
);

select is(
  (
    select erp_can || '/' || erp_eje::text
    from public.orders
    where id = '30000000-0000-0000-0000-000000000010'
  ),
  'B/26',
  'an active customer can read the namespace of its own order'
);
select is(
  (
    select albaran_can || '/' || albaran_eje::text
    from public.orders
    where id = '30000000-0000-0000-0000-000000000010'
  ),
  'B/27',
  'an active customer can read the independent Albarán namespace'
);
select is(
  (
    select pg_catalog.count(*)
    from public.orders
    where id = '30000000-0000-0000-0000-000000000014'
  ),
  0::bigint,
  'orders RLS hides another company ERP identity'
);
select throws_ok(
  $$update public.orders
    set erp_can = 'Z'
    where id = '30000000-0000-0000-0000-000000000010'$$,
  '42501',
  'permission denied for table orders',
  'authenticated cannot mutate ERP identity columns directly'
);
select throws_ok(
  $$select public.bridge_mark_injected(
      '30000000-0000-0000-0000-000000000012',
      '30000000-0000-0000-0000-000000000022',
      'B',
      26,
      70003
    )$$,
  '42501',
  'permission denied for function bridge_mark_injected',
  'authenticated cannot bypass the identity transition RPC ACL'
);

reset role;
select * from finish();
rollback;
