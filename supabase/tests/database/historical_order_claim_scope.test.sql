begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(29);

select ok(
  to_regprocedure(
    'public.bridge_claim_confirmed(uuid,integer,integer)'
  ) is null,
  'the three-argument function identity no longer exists'
);
select ok(
  to_regprocedure(
    'public.bridge_claim_confirmed(uuid,integer,integer,uuid)'
  ) is not null,
  'the claim RPC has an optional target order argument'
);
select is(
  (
    select procedure.pronargdefaults
    from pg_catalog.pg_proc as procedure
    where procedure.oid =
      'public.bridge_claim_confirmed(uuid,integer,integer,uuid)'::regprocedure
  ),
  3::smallint,
  'limit, lease duration and target order all have defaults'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.bridge_claim_confirmed(uuid,integer,integer,uuid)',
    'EXECUTE'
  ),
  'authenticated cannot claim an order'
);
select ok(
  not has_function_privilege(
    'anon',
    'public.bridge_claim_confirmed(uuid,integer,integer,uuid)',
    'EXECUTE'
  ),
  'anon cannot claim an order'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.bridge_claim_confirmed(uuid,integer,integer,uuid)',
    'EXECUTE'
  ),
  'service role can claim orders'
);
select ok(
  not exists (
    select 1
    from pg_catalog.pg_proc as procedure
    cross join lateral pg_catalog.aclexplode(procedure.proacl) as acl
    where procedure.oid =
      'public.bridge_claim_confirmed(uuid,integer,integer,uuid)'::regprocedure
      and acl.grantee = 0
      and acl.privilege_type = 'EXECUTE'
  ),
  'PUBLIC has no implicit execute grant on the claim RPC'
);
select ok(
  (
    select procedure.prosecdef
    from pg_catalog.pg_proc as procedure
    where procedure.oid =
      'public.bridge_claim_confirmed(uuid,integer,integer,uuid)'::regprocedure
  ),
  'the claim RPC is a security definer'
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
      'public.bridge_claim_confirmed(uuid,integer,integer,uuid)'::regprocedure
  ),
  'the claim RPC pins an empty search path'
);

insert into public.companies (id, codcli, name, tarcli)
values (
  '40000000-0000-0000-0000-000000000001',
  900030,
  'Historical Claim Test',
  1
);

insert into public.orders (
  id, company_id, status, confirmed_at
) values
(
  '40000000-0000-0000-0000-000000000010',
  '40000000-0000-0000-0000-000000000001',
  'confirmed',
  pg_catalog.now() - interval '6 minutes'
),
(
  '40000000-0000-0000-0000-000000000011',
  '40000000-0000-0000-0000-000000000001',
  'confirmed',
  pg_catalog.now() - interval '5 minutes'
),
(
  '40000000-0000-0000-0000-000000000012',
  '40000000-0000-0000-0000-000000000001',
  'confirmed',
  pg_catalog.now() - interval '4 minutes'
);

insert into public.orders (
  id,
  company_id,
  status,
  confirmed_at,
  bridge_attempt_count,
  bridge_last_error_code,
  bridge_failed_at,
  bridge_next_attempt_at
) values (
  '40000000-0000-0000-0000-000000000013',
  '40000000-0000-0000-0000-000000000001',
  'confirmed',
  pg_catalog.now() - interval '10 minutes',
  1,
  'TRANSIENT',
  pg_catalog.now(),
  pg_catalog.now() + interval '1 hour'
);

insert into public.orders (id, company_id, status)
values (
  '40000000-0000-0000-0000-000000000014',
  '40000000-0000-0000-0000-000000000001',
  'submitted'
);

insert into public.orders (
  id, company_id, status, confirmed_at,
  bridge_claim_token, bridge_claimed_at, bridge_attempt_count
) values (
  '40000000-0000-0000-0000-000000000015',
  '40000000-0000-0000-0000-000000000001',
  'processing',
  pg_catalog.now() - interval '20 minutes',
  '40000000-0000-0000-0000-000000000025',
  pg_catalog.now(),
  1
);

set local role service_role;

select throws_ok(
  $$select public.bridge_claim_confirmed(
      '40000000-0000-0000-0000-000000000019',
      null,
      300,
      null
    )$$,
  'P0001',
  'BAD_CLAIM_LIMIT',
  'a NULL claim limit is rejected fail-closed'
);
select throws_ok(
  $$select public.bridge_claim_confirmed(
      '40000000-0000-0000-0000-000000000019',
      50,
      null,
      null
    )$$,
  'P0001',
  'BAD_LEASE_SECONDS',
  'a NULL lease duration is rejected fail-closed'
);

select ok(
  (
    with result as (
      select public.bridge_claim_confirmed(
        '40000000-0000-0000-0000-000000000020',
        1,
        300,
        null
      ) as payload
    )
    select pg_catalog.jsonb_array_length(payload) = 1
      and payload->0->>'id' = '40000000-0000-0000-0000-000000000010'
      and payload->0->>'claim_token' =
        '40000000-0000-0000-0000-000000000020'
    from result
  ),
  'an explicit NULL target performs the ordinary FIFO batch claim'
);
select is(
  (
    select pg_catalog.count(*)
    from public.orders
    where id in (
      '40000000-0000-0000-0000-000000000011',
      '40000000-0000-0000-0000-000000000012'
    )
      and status = 'confirmed'
      and bridge_claim_token is null
  ),
  2::bigint,
  'the NULL-target batch still respects its limit'
);
select ok(
  (
    with result as (
      select public.bridge_claim_confirmed(
        '40000000-0000-0000-0000-000000000020',
        1,
        300,
        null
      ) as payload
    )
    select pg_catalog.jsonb_array_length(payload) = 1
      and payload->0->>'id' = '40000000-0000-0000-0000-000000000010'
      and payload->0->>'claim_token' =
        '40000000-0000-0000-0000-000000000020'
    from result
  ),
  'an identical ordinary retry replays its original FIFO batch'
);
select is(
  (
    select pg_catalog.count(*)
    from public.order_events
    where order_id = '40000000-0000-0000-0000-000000000010'
      and event = 'bridge_claimed'
  ),
  1::bigint,
  'ordinary claim replay does not duplicate its event'
);

select ok(
  (
    with result as (
      select public.bridge_claim_confirmed(
        '40000000-0000-0000-0000-000000000021',
        50,
        300,
        '40000000-0000-0000-0000-000000000011'
      ) as payload
    )
    select pg_catalog.jsonb_array_length(payload) = 1
      and payload->0->>'id' = '40000000-0000-0000-0000-000000000011'
      and payload->0->>'claim_token' =
        '40000000-0000-0000-0000-000000000021'
    from result
  ),
  'a target claim leases the specified eligible order'
);
select ok(
  (
    select status = 'confirmed' and bridge_claim_token is null
    from public.orders
    where id = '40000000-0000-0000-0000-000000000012'
  ),
  'a target claim does not consume another simultaneously queued order'
);
select ok(
  (
    select pg_catalog.count(*) = 1
    from public.order_events
    where order_id = '40000000-0000-0000-0000-000000000011'
      and event = 'bridge_claimed'
      and detail->>'claim_token' =
        '40000000-0000-0000-0000-000000000021'
  ),
  'the target claim emits exactly its own lease event'
);

select ok(
  (
    with result as (
      select public.bridge_claim_confirmed(
        '40000000-0000-0000-0000-000000000021',
        50,
        300,
        '40000000-0000-0000-0000-000000000011'
      ) as payload
    )
    select pg_catalog.jsonb_array_length(payload) = 1
      and payload->0->>'id' = '40000000-0000-0000-0000-000000000011'
      and payload->0->>'claim_token' =
        '40000000-0000-0000-0000-000000000021'
    from result
  ),
  'an identical targeted retry replays its still-live claim'
);
select is(
  (
    select pg_catalog.count(*)
    from public.order_events
    where order_id = '40000000-0000-0000-0000-000000000011'
      and event = 'bridge_claimed'
  ),
  1::bigint,
  'replaying the same claim does not duplicate its event'
);

select is(
  public.bridge_claim_confirmed(
    '40000000-0000-0000-0000-000000000026',
    50,
    300,
    '40000000-0000-0000-0000-000000000015'
  ),
  '[]'::jsonb,
  'a different token cannot take over a live targeted lease'
);
update public.orders
set bridge_claimed_at = pg_catalog.now() - interval '10 minutes'
where id = '40000000-0000-0000-0000-000000000015';
select ok(
  (
    with result as (
      select public.bridge_claim_confirmed(
        '40000000-0000-0000-0000-000000000026',
        50,
        300,
        '40000000-0000-0000-0000-000000000015'
      ) as payload
    )
    select pg_catalog.jsonb_array_length(payload) = 1
      and payload->0->>'id' = '40000000-0000-0000-0000-000000000015'
    from result
  ),
  'an expired targeted lease can be reclaimed by a new token'
);

select is(
  public.bridge_claim_confirmed(
    '40000000-0000-0000-0000-000000000022',
    50,
    300,
    '40000000-0000-0000-0000-000000000099'
  ),
  '[]'::jsonb,
  'a nonexistent target returns an empty claim'
);
select ok(
  (
    select status = 'confirmed' and bridge_claim_token is null
    from public.orders
    where id = '40000000-0000-0000-0000-000000000012'
  ),
  'a nonexistent target does not fall through to other queued work'
);

select is(
  public.bridge_claim_confirmed(
    '40000000-0000-0000-0000-000000000023',
    50,
    300,
    '40000000-0000-0000-0000-000000000013'
  ),
  '[]'::jsonb,
  'a target whose retry backoff is pending returns an empty claim'
);
select ok(
  (
    select status = 'confirmed'
      and bridge_claim_token is null
      and bridge_next_attempt_at > pg_catalog.now()
    from public.orders
    where id = '40000000-0000-0000-0000-000000000013'
  ),
  'an ineligible target keeps its backoff and state untouched'
);
select is(
  public.bridge_claim_confirmed(
    '40000000-0000-0000-0000-000000000024',
    50,
    300,
    '40000000-0000-0000-0000-000000000014'
  ),
  '[]'::jsonb,
  'a submitted target returns an empty claim'
);

select ok(
  (
    with result as (
      select public.bridge_claim_confirmed(
        '40000000-0000-0000-0000-000000000027',
        50,
        300
      ) as payload
    )
    select pg_catalog.jsonb_array_length(payload) = 1
      and payload->0->>'id' = '40000000-0000-0000-0000-000000000012'
      and payload->0->>'claim_token' =
        '40000000-0000-0000-0000-000000000027'
    from result
  ),
  'omitting the optional target preserves the legacy batch call shape'
);
select ok(
  (
    select
      (select status from public.orders
       where id = '40000000-0000-0000-0000-000000000013') = 'confirmed'
      and
      (select status from public.orders
       where id = '40000000-0000-0000-0000-000000000014') = 'submitted'
      and
      (select bridge_claim_token from public.orders
       where id = '40000000-0000-0000-0000-000000000015') =
        '40000000-0000-0000-0000-000000000026'
  ),
  'ordinary batching still skips deferred, submitted and live-leased orders'
);

reset role;
select * from finish();
rollback;
