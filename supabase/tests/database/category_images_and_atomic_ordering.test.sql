begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(33);

select has_column(
  'public',
  'categories',
  'image_url',
  'categories exposes an image URL'
);
select col_type_is(
  'public',
  'categories',
  'image_url',
  'text',
  'category image URL is text'
);
select is(
  (
    select is_nullable
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'categories'
      and column_name = 'image_url'
  ),
  'YES',
  'category artwork is optional'
);
select ok(
  has_column_privilege(
    'authenticated',
    'public.categories',
    'image_url',
    'SELECT'
  ),
  'authenticated callers can read category artwork under RLS'
);
select ok(
  has_column_privilege(
    'authenticated',
    'public.categories',
    'image_url',
    'UPDATE'
  ),
  'authenticated staff actions may update category artwork under RLS'
);
select ok(
  not has_column_privilege(
    'authenticated',
    'public.categories',
    'sort_order',
    'UPDATE'
  ),
  'authenticated cannot bypass atomic ordering with direct sort updates'
);
select has_function(
  'public',
  'staff_reorder_categories',
  array['bigint[]', 'text'],
  'atomic category reorder RPC exists'
);
select ok(
  has_function_privilege(
    'authenticated',
    'public.staff_reorder_categories(bigint[],text)',
    'EXECUTE'
  ),
  'authenticated may call the reorder RPC'
);
select ok(
  not has_function_privilege(
    'anon',
    'public.staff_reorder_categories(bigint[],text)',
    'EXECUTE'
  ),
  'anon cannot call the reorder RPC'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.staff_reorder_categories(bigint[],text)',
    'EXECUTE'
  ),
  'service role retains explicit RPC access'
);
select is(
  (
    select procedure.prosecdef
    from pg_catalog.pg_proc as procedure
    where procedure.oid =
      'public.staff_reorder_categories(bigint[],text)'::regprocedure
  ),
  true,
  'the RPC is a security definer because direct sort writes are revoked'
);
select ok(
  exists (
    select 1
    from pg_catalog.pg_proc as procedure
    cross join lateral pg_catalog.unnest(procedure.proconfig) as setting(value)
    where procedure.oid =
      'public.staff_reorder_categories(bigint[],text)'::regprocedure
      and pg_catalog.split_part(setting.value, '=', 1) = 'search_path'
      and pg_catalog.replace(
        pg_catalog.split_part(setting.value, '=', 2),
        '"',
        ''
      ) = ''
  ),
  'the security definer pins an empty search path'
);
select ok(
  pg_catalog.strpos(
    pg_catalog.lower(
      pg_catalog.pg_get_functiondef(
        'public.staff_reorder_categories(bigint[],text)'::regprocedure
      )
    ),
    'lock table public.categories in share row exclusive mode'
  ) > 0,
  'the RPC locks the collection before validating the full set'
);

-- Isolate a six-row tree; every change is rolled back at the end of this file.
delete from public.category_companies;
update public.products set category_id = null;
delete from public.categories;

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
values
(
  '22000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'category-staff@example.invalid', '',
  pg_catalog.now(), '{}'::jsonb, '{}'::jsonb,
  pg_catalog.now(), pg_catalog.now()
),
(
  '22000000-0000-0000-0000-000000000002',
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'category-customer@example.invalid', '',
  pg_catalog.now(), '{}'::jsonb, '{}'::jsonb,
  pg_catalog.now(), pg_catalog.now()
);

insert into public.staff_users (id, role, display_name, is_active)
values (
  '22000000-0000-0000-0000-000000000001',
  'staff',
  'Category Staff',
  true
);

insert into public.categories (
  erp_code, name, parent_label, sort_order, is_active
)
values
  ('tap-cat-a', '{"zh":"A","es":"A"}', null, 10, true),
  ('tap-cat-g1', '{"zh":"G1","es":"G1"}',
    '{"zh":"组","es":"Grupo"}', 20, true),
  ('tap-cat-g2', '{"zh":"G2","es":"G2"}',
    '{"zh":"组","es":"Grupo"}', 30, true),
  ('tap-cat-b', '{"zh":"B","es":"B"}', null, 40, true),
  ('tap-cat-h1', '{"zh":"H1","es":"H1"}',
    '{"zh":"尾","es":"Cola"}', 50, true),
  ('tap-cat-h2', '{"zh":"H2","es":"H2"}',
    '{"zh":"尾","es":"Cola"}', 60, true);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"22000000-0000-0000-0000-000000000001","role":"authenticated"}',
  true
);

select throws_ok(
  $$update public.categories set sort_order = sort_order
    where erp_code = 'tap-cat-a'$$,
  '42501',
  'permission denied for table categories',
  'even staff cannot patch sort_order directly'
);
select lives_ok(
  $$update public.categories
    set image_url = 'https://example.invalid/category.webp'
    where erp_code = 'tap-cat-a'$$,
  'staff may update category artwork through the RLS-protected column'
);
reset role;
select is(
  (
    select image_url
    from public.categories
    where erp_code = 'tap-cat-a'
  ),
  'https://example.invalid/category.webp',
  'category artwork update is persisted'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"22000000-0000-0000-0000-000000000002","role":"authenticated"}',
  true
);
select throws_ok(
  $$select public.staff_reorder_categories(
      (select pg_catalog.array_agg(id order by sort_order)
       from public.categories),
      'zh'
    )$$,
  '42501',
  'STAFF_ONLY',
  'a customer cannot reorder categories'
);

select set_config('request.jwt.claims', '{}', true);
select throws_ok(
  $$select public.staff_reorder_categories(
      (select pg_catalog.array_agg(id order by sort_order)
       from public.categories),
      'zh'
    )$$,
  '42501',
  'STAFF_ONLY',
  'an authenticated request without a user cannot reorder categories'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"22000000-0000-0000-0000-000000000001","role":"authenticated"}',
  true
);
select throws_ok(
  $$select public.staff_reorder_categories(
      (select pg_catalog.array_agg(id order by sort_order)
       from public.categories),
      'ZH'
    )$$,
  '22023',
  'BAD_LOCALE',
  'locale is a closed pair'
);
select throws_ok(
  $$select public.staff_reorder_categories(
      (select pg_catalog.array_agg(id order by sort_order)
       from public.categories),
      null
    )$$,
  '22023',
  'BAD_LOCALE',
  'locale cannot be null'
);
select throws_ok(
  $$select public.staff_reorder_categories(null, 'zh')$$,
  '22023',
  'BAD_ORDER',
  'order cannot be null'
);
select throws_ok(
  $$select public.staff_reorder_categories('{}'::bigint[], 'zh')$$,
  '22023',
  'BAD_ORDER',
  'order cannot be empty'
);
select throws_ok(
  $$select public.staff_reorder_categories(
      array[
        (select id from public.categories where erp_code = 'tap-cat-a'),
        (select id from public.categories where erp_code = 'tap-cat-a')
      ],
      'zh'
    )$$,
  '22023',
  'BAD_ORDER',
  'duplicate ids are rejected'
);
select throws_ok(
  $$select public.staff_reorder_categories(
      (select pg_catalog.array_agg(id order by sort_order)
       from public.categories
       where erp_code <> 'tap-cat-h2'),
      'zh'
    )$$,
  '22023',
  'BAD_ORDER',
  'a missing category is rejected'
);
select throws_ok(
  $$select public.staff_reorder_categories(
      (select pg_catalog.array_agg(id order by sort_order)
       from public.categories) || 9223372036854775807::bigint,
      'zh'
    )$$,
  '22023',
  'BAD_ORDER',
  'an unknown category is rejected'
);
select throws_ok(
  $$select public.staff_reorder_categories(
      array[
        array[
          (select id from public.categories where erp_code = 'tap-cat-a'),
          (select id from public.categories where erp_code = 'tap-cat-g1'),
          (select id from public.categories where erp_code = 'tap-cat-g2')
        ],
        array[
          (select id from public.categories where erp_code = 'tap-cat-b'),
          (select id from public.categories where erp_code = 'tap-cat-h1'),
          (select id from public.categories where erp_code = 'tap-cat-h2')
        ]
      ],
      'zh'
    )$$,
  '22023',
  'BAD_ORDER',
  'multidimensional arrays are rejected'
);
select throws_ok(
  $$select public.staff_reorder_categories(
      (select pg_catalog.array_agg(id order by case erp_code
        when 'tap-cat-g1' then 1
        when 'tap-cat-a' then 2
        when 'tap-cat-g2' then 3
        when 'tap-cat-b' then 4
        when 'tap-cat-h1' then 5
        when 'tap-cat-h2' then 6 end)
       from public.categories),
      'zh'
    )$$,
  '22023',
  'BAD_TREE',
  'children from one parent cannot be interleaved with another tree entry'
);
reset role;
select is(
  (
    select pg_catalog.array_agg(sort_order order by erp_code)
    from public.categories
  ),
  array[10, 40, 20, 30, 50, 60],
  'a rejected tree leaves every stored position unchanged'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"22000000-0000-0000-0000-000000000001","role":"authenticated"}',
  true
);
select is(
  public.staff_reorder_categories(
    (select pg_catalog.array_agg(id order by case erp_code
      when 'tap-cat-b' then 1
      when 'tap-cat-g2' then 2
      when 'tap-cat-g1' then 3
      when 'tap-cat-a' then 4
      when 'tap-cat-h2' then 5
      when 'tap-cat-h1' then 6 end)
     from public.categories),
    'zh'
  ),
  true,
  'staff writes a valid complete flattened tree'
);
reset role;
select is(
  (
    select pg_catalog.array_agg(erp_code order by sort_order)
    from public.categories
  ),
  array[
    'tap-cat-b', 'tap-cat-g2', 'tap-cat-g1',
    'tap-cat-a', 'tap-cat-h2', 'tap-cat-h1'
  ],
  'the requested top-level and child order is persisted'
);
select is(
  (
    select pg_catalog.array_agg(sort_order order by sort_order)
    from public.categories
  ),
  array[10, 20, 30, 40, 50, 60],
  'the RPC normalizes positions into strict ten-point steps'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"22000000-0000-0000-0000-000000000001","role":"authenticated"}',
  true
);
select is(
  public.staff_reorder_categories(
    (select pg_catalog.array_agg(id order by case erp_code
      when 'tap-cat-a' then 1
      when 'tap-cat-h1' then 2
      when 'tap-cat-h2' then 3
      when 'tap-cat-g1' then 4
      when 'tap-cat-g2' then 5
      when 'tap-cat-b' then 6 end)
     from public.categories),
    'es'
  ),
  true,
  'the same validated tree contract works in Spanish'
);
reset role;
select is(
  (
    select pg_catalog.array_agg(erp_code order by sort_order)
    from public.categories
  ),
  array[
    'tap-cat-a', 'tap-cat-h1', 'tap-cat-h2',
    'tap-cat-g1', 'tap-cat-g2', 'tap-cat-b'
  ],
  'Spanish order is persisted without changing parent relationships'
);

select * from finish();
rollback;
