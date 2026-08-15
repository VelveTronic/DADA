begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(36);

select ok(
  not has_table_privilege('authenticated', 'public.orders', 'UPDATE'),
  'authenticated cannot update orders directly'
);
select ok(
  not has_column_privilege('authenticated', 'public.products', 'price_1_cents', 'SELECT'),
  'authenticated cannot read raw price tiers'
);
select ok(
  not has_column_privilege('authenticated', 'public.products', 'price_1_cents', 'UPDATE'),
  'authenticated cannot update raw price tiers'
);
select ok(
  not has_column_privilege('authenticated', 'public.orders', 'staff_note', 'SELECT'),
  'authenticated cannot read staff notes'
);
select ok(
  not has_column_privilege('authenticated', 'public.companies', 'notes', 'SELECT'),
  'authenticated cannot read company notes'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.bridge_claim_confirmed(uuid,integer,integer)',
    'EXECUTE'
  ),
  'authenticated cannot claim bridge work'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.bridge_claim_confirmed(uuid,integer,integer)',
    'EXECUTE'
  ),
  'service role can claim bridge work'
);
select ok(
  has_schema_privilege('authenticated', 'private', 'USAGE'),
  'authenticated can enter private schema for RLS helpers'
);
select ok(
  has_function_privilege('authenticated', 'private.is_staff()', 'EXECUTE'),
  'authenticated can execute staff RLS helper'
);
select ok(
  has_function_privilege('authenticated', 'private.my_company_id()', 'EXECUTE'),
  'authenticated can execute company RLS helper'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'private.enforce_exclusive_user_role()',
    'EXECUTE'
  ),
  'authenticated cannot execute trigger internals'
);
select is(
  (
    select delete_rule
    from information_schema.referential_constraints
    where constraint_schema = 'public'
      and constraint_name = 'orders_placed_by_fkey'
  ),
  'SET NULL',
  'deleting a portal user preserves order history'
);
select is(
  (
    select delete_rule
    from information_schema.referential_constraints
    where constraint_schema = 'public'
      and constraint_name = 'order_items_product_id_fkey'
  ),
  'SET NULL',
  'deleting a product preserves item snapshots'
);
select ok(
  to_regprocedure('public.is_staff()') is null
    and to_regprocedure('public.my_company_id()') is null,
  'RLS helpers are not exposed in public'
);
select ok(
  not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'orders'
      and cmd in ('UPDATE', 'ALL')
  ),
  'orders have no direct authenticated update policy'
);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
(
  '00000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'contract-portal@example.invalid', '',
  now(), '{}'::jsonb, '{}'::jsonb, now(), now()
),
(
  '00000000-0000-0000-0000-000000000002',
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'contract-staff@example.invalid', '',
  now(), '{}'::jsonb, '{}'::jsonb, now(), now()
);

insert into public.companies (id, codcli, name, tarcli)
values ('00000000-0000-0000-0000-000000000003', 900001, 'Contract Test', 1);

insert into public.portal_users (id, company_id, display_name)
values (
  '00000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000003',
  'Portal Test'
);

select throws_ok(
  $$insert into public.staff_users (id, role)
    values ('00000000-0000-0000-0000-000000000001', 'staff')$$,
  '23505',
  'USER_ROLE_CONFLICT',
  'one auth user cannot have portal and staff roles'
);

insert into public.staff_users (id, role, display_name)
values (
  '00000000-0000-0000-0000-000000000002',
  'manager',
  'Staff Test'
);

insert into public.products (
  id, codart, base_sku, variant_suffix, name, unit, is_weighed,
  price_1_cents, is_available, is_current_variant
) values (
  '00000000-0000-0000-0000-000000000004',
  'TEST-001', 'TEST-001', '',
  '{"es":"Test product"}'::jsonb,
  'UNIDAD', false, 250, true, true
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000000001","role":"authenticated"}',
  true
);

select is(
  (select count(*) from public.products),
  1::bigint,
  'active portal user can read the catalog'
);
select is(
  (select price_cents from public.products_priced),
  250,
  'customer sees only the company price tier'
);
select ok(
  (
    public.create_order(
      jsonb_build_array(
        jsonb_build_object(
          'product_id', '00000000-0000-0000-0000-000000000004',
          'qty', 1
        ),
        jsonb_build_object(
          'product_id', '00000000-0000-0000-0000-000000000004',
          'qty', 2
        )
      ),
      null,
      '  test note  ',
      '00000000-0000-0000-0000-000000000005'
    )->>'order_id'
  )::uuid is not null,
  'portal user creates an order'
);
select is(
  (
    select subtotal_cents
    from public.orders
    where company_id = '00000000-0000-0000-0000-000000000003'
  ),
  750,
  'order subtotal is recalculated server-side'
);
select is(
  (
    select qty
    from public.order_items
    where order_id = (
      select id from public.orders
      where company_id = '00000000-0000-0000-0000-000000000003'
    )
  ),
  3::numeric,
  'duplicate product lines are merged'
);
select is(
  (
    public.create_order(
      jsonb_build_array(
        jsonb_build_object(
          'product_id', '00000000-0000-0000-0000-000000000004',
          'qty', 3
        )
      ),
      null,
      'test note',
      '00000000-0000-0000-0000-000000000005'
    )->>'duplicate'
  )::boolean,
  true,
  'equivalent idempotent retry returns the existing order'
);
select throws_ok(
  $$select public.create_order(
      jsonb_build_array(
        jsonb_build_object(
          'product_id', '00000000-0000-0000-0000-000000000004',
          'qty', 4
        )
      ),
      null,
      'test note',
      '00000000-0000-0000-0000-000000000005'
    )$$,
  '22023',
  'IDEMPOTENCY_MISMATCH',
  'idempotency token cannot be reused for different contents'
);
select throws_ok(
  $$select public.create_order(
      jsonb_build_array(
        jsonb_build_object(
          'product_id', '00000000-0000-0000-0000-000000000004',
          'qty', 1.5
        )
      ),
      null,
      null,
      '00000000-0000-0000-0000-000000000007'
    )$$,
  'P0001',
  'BAD_QTY_STEP:TEST-001',
  'non-weighed products require integral quantities'
);
select throws_ok(
  $$select public.staff_confirm_order(
      (select id from public.orders
       where company_id = '00000000-0000-0000-0000-000000000003'),
      null
    )$$,
  '42501',
  'STAFF_ONLY',
  'portal user cannot invoke staff state transitions'
);
select throws_ok(
  $$update public.orders set status = 'confirmed'
    where company_id = '00000000-0000-0000-0000-000000000003'$$,
  '42501',
  'permission denied for table orders',
  'portal user cannot bypass the order state machine'
);
select throws_ok(
  $$update public.products set price_1_cents = 1
    where id = '00000000-0000-0000-0000-000000000004'$$,
  '42501',
  'permission denied for table products',
  'portal user cannot update a raw price tier'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000000002","role":"authenticated"}',
  true
);
select is(
  public.staff_confirm_order(
    (
      select id from public.orders
      where company_id = '00000000-0000-0000-0000-000000000003'
    ),
    'verified'
  ),
  true,
  'staff confirms a submitted order'
);
select is(
  public.staff_confirm_order(
    (
      select id from public.orders
      where company_id = '00000000-0000-0000-0000-000000000003'
    ),
    'again'
  ),
  false,
  'staff cannot confirm an order twice'
);

reset role;
set local role service_role;

select is(
  jsonb_array_length(
    public.bridge_claim_confirmed(
      '00000000-0000-0000-0000-000000000006',
      10,
      300
    )
  ),
  1,
  'bridge atomically claims one confirmed order'
);
select is(
  public.bridge_mark_injected(
    (
      select id from public.orders
      where company_id = '00000000-0000-0000-0000-000000000003'
    ),
    '00000000-0000-0000-0000-000000000008',
    12345
  ),
  false,
  'bridge rejects a mismatched claim token'
);
select is(
  public.bridge_mark_injected(
    (
      select id from public.orders
      where company_id = '00000000-0000-0000-0000-000000000003'
    ),
    null,
    12345
  ),
  false,
  'bridge rejects a null claim token'
);
select is(
  public.bridge_mark_injected(
    (
      select id from public.orders
      where company_id = '00000000-0000-0000-0000-000000000003'
    ),
    '00000000-0000-0000-0000-000000000006',
    12345
  ),
  true,
  'bridge marks only its claimed order as injected'
);
select is(
  public.bridge_mark_albaran(
    (
      select id from public.orders
      where company_id = '00000000-0000-0000-0000-000000000003'
    ),
    54321
  ),
  true,
  'bridge records a positive albaran number'
);

delete from public.portal_users
where id = '00000000-0000-0000-0000-000000000001';
delete from public.products
where id = '00000000-0000-0000-0000-000000000004';

select ok(
  (
    select placed_by is null
    from public.orders
    where company_id = '00000000-0000-0000-0000-000000000003'
  ),
  'deleting a portal profile nulls the historical actor reference'
);
select ok(
  (
    select product_id is null
    from public.order_items
    where order_id = (
      select id from public.orders
      where company_id = '00000000-0000-0000-0000-000000000003'
    )
  ),
  'deleting a product nulls the reference but keeps the item snapshot'
);

reset role;
select * from finish();
rollback;
