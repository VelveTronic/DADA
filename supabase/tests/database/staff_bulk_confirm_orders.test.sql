begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(33);

select ok(
  has_function_privilege(
    'authenticated',
    'public.staff_bulk_confirm_orders(uuid[])',
    'EXECUTE'
  ),
  'authenticated may enter the staff bulk-confirm RPC'
);
select ok(
  not has_function_privilege(
    'anon',
    'public.staff_bulk_confirm_orders(uuid[])',
    'EXECUTE'
  ),
  'anon cannot execute the staff bulk-confirm RPC'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.staff_bulk_confirm_orders(uuid[])',
    'EXECUTE'
  ),
  'service role retains the project standard RPC grant'
);
select ok(
  (
    select procedure.prosecdef
    from pg_catalog.pg_proc as procedure
    where procedure.oid =
      'public.staff_bulk_confirm_orders(uuid[])'::regprocedure
  ),
  'bulk confirm is a security-definer function'
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
      'public.staff_bulk_confirm_orders(uuid[])'::regprocedure
  ),
  'bulk confirm pins an empty search path'
);
select ok(
  pg_catalog.strpos(
    pg_catalog.pg_get_functiondef(
      'public.staff_bulk_confirm_orders(uuid[])'::regprocedure
    ),
    'order by queued.id'
  ) > 0,
  'bulk confirm takes eligible row locks in a deterministic order'
);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
values
(
  '22000000-0000-4000-8000-000000000001',
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'bulk-staff@example.invalid', '',
  pg_catalog.now(), '{}'::jsonb, '{}'::jsonb,
  pg_catalog.now(), pg_catalog.now()
),
(
  '22000000-0000-4000-8000-000000000002',
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'bulk-customer@example.invalid', '',
  pg_catalog.now(), '{}'::jsonb, '{}'::jsonb,
  pg_catalog.now(), pg_catalog.now()
),
(
  '22000000-0000-4000-8000-000000000003',
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'bulk-inactive-staff@example.invalid', '',
  pg_catalog.now(), '{}'::jsonb, '{}'::jsonb,
  pg_catalog.now(), pg_catalog.now()
);

insert into public.staff_users (id, role, display_name, is_active)
values
(
  '22000000-0000-4000-8000-000000000001',
  'staff',
  'Bulk Staff',
  true
),
(
  '22000000-0000-4000-8000-000000000003',
  'staff',
  'Inactive Bulk Staff',
  false
);

insert into public.companies (id, codcli, name, tarcli)
values (
  '22000000-0000-4000-8000-000000000100',
  922000,
  'Bulk Confirm Contract',
  1
);

insert into public.portal_users (id, company_id, display_name, is_active)
values (
  '22000000-0000-4000-8000-000000000002',
  '22000000-0000-4000-8000-000000000100',
  'Bulk Customer',
  true
);

insert into public.orders (id, company_id, status, confirmed_at)
values
(
  '22000000-0000-4000-8000-000000000010',
  '22000000-0000-4000-8000-000000000100',
  'submitted',
  null
),
(
  '22000000-0000-4000-8000-000000000011',
  '22000000-0000-4000-8000-000000000100',
  'submitted',
  null
),
(
  '22000000-0000-4000-8000-000000000012',
  '22000000-0000-4000-8000-000000000100',
  'confirmed',
  '2026-01-01T00:00:00Z'
),
(
  '22000000-0000-4000-8000-000000000013',
  '22000000-0000-4000-8000-000000000100',
  'cancelled',
  null
);

set local role authenticated;

select set_config(
  'request.jwt.claims',
  '{"sub":"22000000-0000-4000-8000-000000000002","role":"authenticated"}',
  true
);
select throws_ok(
  $$select public.staff_bulk_confirm_orders(
      array['22000000-0000-4000-8000-000000000010'::uuid]
    )$$,
  '42501',
  'STAFF_ONLY',
  'a customer cannot bulk-confirm orders'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"22000000-0000-4000-8000-000000000003","role":"authenticated"}',
  true
);
select throws_ok(
  $$select public.staff_bulk_confirm_orders(
      array['22000000-0000-4000-8000-000000000010'::uuid]
    )$$,
  '42501',
  'STAFF_ONLY',
  'an inactive staff user cannot bulk-confirm orders'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"22000000-0000-4000-8000-000000000001","role":"authenticated"}',
  true
);

select throws_ok(
  $$select public.staff_bulk_confirm_orders(null::uuid[])$$,
  '22023',
  'BAD_ORDER_IDS',
  'a null selection is rejected'
);
select throws_ok(
  $$select public.staff_bulk_confirm_orders('{}'::uuid[])$$,
  '22023',
  'BAD_ORDER_IDS',
  'an empty selection is rejected'
);
select throws_ok(
  $$select public.staff_bulk_confirm_orders(array[null]::uuid[])$$,
  '22023',
  'BAD_ORDER_IDS',
  'a selection containing null is rejected'
);
select throws_ok(
  $$select public.staff_bulk_confirm_orders(
      pg_catalog.array_fill(
        '22000000-0000-4000-8000-000000000010'::uuid,
        array[51]
      )
    )$$,
  '22023',
  'BAD_ORDER_IDS',
  'the raw request is capped before duplicate removal'
);

-- One RPC call carries two eligible orders, one already-confirmed order, one
-- missing id and a duplicate.  Store its JSON reply in a transaction-local GUC
-- so every assertion below examines the same state transition.
select set_config(
  'test.bulk_confirm_result',
  public.staff_bulk_confirm_orders(array[
    '22000000-0000-4000-8000-000000000010'::uuid,
    '22000000-0000-4000-8000-000000000010'::uuid,
    '22000000-0000-4000-8000-000000000012'::uuid,
    '22000000-0000-4000-8000-000000000099'::uuid,
    '22000000-0000-4000-8000-000000000011'::uuid
  ])::text,
  true
);

select is(
  (current_setting('test.bulk_confirm_result')::jsonb ->> 'requested_count')::integer,
  4,
  'duplicate ids count once in the normalized request'
);
select is(
  (current_setting('test.bulk_confirm_result')::jsonb ->> 'confirmed_count')::integer,
  2,
  'both submitted orders are confirmed'
);
select is(
  (current_setting('test.bulk_confirm_result')::jsonb ->> 'skipped_count')::integer,
  2,
  'wrong-state and missing orders are reported as skipped'
);
select is(
  current_setting('test.bulk_confirm_result')::jsonb -> 'confirmed_ids',
  '[
    "22000000-0000-4000-8000-000000000010",
    "22000000-0000-4000-8000-000000000011"
  ]'::jsonb,
  'confirmed ids retain their first-request order'
);
select is(
  current_setting('test.bulk_confirm_result')::jsonb -> 'skipped_ids',
  '[
    "22000000-0000-4000-8000-000000000012",
    "22000000-0000-4000-8000-000000000099"
  ]'::jsonb,
  'skipped ids retain their first-request order'
);
select is(
  (
    select pg_catalog.count(*)
    from public.orders
    where id in (
      '22000000-0000-4000-8000-000000000010',
      '22000000-0000-4000-8000-000000000011'
    )
      and status = 'confirmed'
  ),
  2::bigint,
  'the two eligible order states are persisted'
);
select is(
  (
    select pg_catalog.count(*)
    from public.orders
    where id in (
      '22000000-0000-4000-8000-000000000010',
      '22000000-0000-4000-8000-000000000011'
    )
      and confirmed_at is not null
  ),
  2::bigint,
  'each newly confirmed order receives a confirmation timestamp'
);
select is(
  (
    select confirmed_at
    from public.orders
    where id = '22000000-0000-4000-8000-000000000012'
  ),
  '2026-01-01T00:00:00Z'::timestamptz,
  'an already-confirmed order keeps its original timestamp'
);
select is(
  (
    select status
    from public.orders
    where id = '22000000-0000-4000-8000-000000000013'
  ),
  'cancelled',
  'an unrelated cancelled order is unchanged'
);
select is(
  (
    select pg_catalog.count(*)
    from public.order_events
    where order_id in (
      '22000000-0000-4000-8000-000000000010',
      '22000000-0000-4000-8000-000000000011'
    )
      and event = 'confirmed'
  ),
  2::bigint,
  'one confirmed event is written for each successful transition'
);
select is(
  (
    select pg_catalog.count(*)
    from public.order_events
    where order_id = '22000000-0000-4000-8000-000000000010'
      and event = 'confirmed'
  ),
  1::bigint,
  'a duplicate request id does not duplicate its audit event'
);
select is(
  (
    select pg_catalog.count(*)
    from public.order_events
    where order_id = '22000000-0000-4000-8000-000000000012'
      and event = 'confirmed'
  ),
  0::bigint,
  'an already-confirmed order receives no new audit event'
);
select is(
  (
    select pg_catalog.count(*)
    from public.order_events
    where order_id in (
      '22000000-0000-4000-8000-000000000010',
      '22000000-0000-4000-8000-000000000011'
    )
      and event = 'confirmed'
      and actor = '22000000-0000-4000-8000-000000000001'
  ),
  2::bigint,
  'every audit event records the authenticated staff actor'
);

select set_config(
  'test.bulk_confirm_replay',
  public.staff_bulk_confirm_orders(array[
    '22000000-0000-4000-8000-000000000010'::uuid,
    '22000000-0000-4000-8000-000000000011'::uuid
  ])::text,
  true
);
select is(
  (current_setting('test.bulk_confirm_replay')::jsonb ->> 'requested_count')::integer,
  2,
  'a repeated request still reports its normalized selection'
);
select is(
  (current_setting('test.bulk_confirm_replay')::jsonb ->> 'confirmed_count')::integer,
  0,
  'a repeated request cannot confirm the same orders again'
);
select is(
  (current_setting('test.bulk_confirm_replay')::jsonb ->> 'skipped_count')::integer,
  2,
  'a repeated request reports both now-wrong-state rows as skipped'
);
select is(
  current_setting('test.bulk_confirm_replay')::jsonb -> 'confirmed_ids',
  '[]'::jsonb,
  'a repeated request returns an empty confirmed id list'
);
select is(
  current_setting('test.bulk_confirm_replay')::jsonb -> 'skipped_ids',
  '[
    "22000000-0000-4000-8000-000000000010",
    "22000000-0000-4000-8000-000000000011"
  ]'::jsonb,
  'a repeated request reports skipped ids in request order'
);
select is(
  (
    select pg_catalog.count(*)
    from public.order_events
    where order_id in (
      '22000000-0000-4000-8000-000000000010',
      '22000000-0000-4000-8000-000000000011'
    )
      and event = 'confirmed'
  ),
  2::bigint,
  'a repeated request writes no duplicate audit events'
);

-- Exactly fifty raw entries are accepted, then de-duplicated to one requested
-- id.  This pins the inclusive side of the request ceiling.
select set_config(
  'test.bulk_confirm_ceiling',
  public.staff_bulk_confirm_orders(
    pg_catalog.array_fill(
      '22000000-0000-4000-8000-000000000010'::uuid,
      array[50]
    )
  )::text,
  true
);
select is(
  (current_setting('test.bulk_confirm_ceiling')::jsonb ->> 'requested_count')::integer,
  1,
  'fifty raw ids are accepted and de-duplicated'
);
select is(
  (current_setting('test.bulk_confirm_ceiling')::jsonb ->> 'skipped_count')::integer,
  1,
  'the accepted ceiling call still applies state checks'
);

reset role;
select * from finish();
rollback;
