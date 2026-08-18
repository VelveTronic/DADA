begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(47);

-- Privilege boundary: operational error text never becomes a customer-readable
-- order column, while only the bridge can report failures.
select ok(
  not has_column_privilege(
    'authenticated',
    'public.orders',
    'bridge_last_error_message',
    'SELECT'
  ),
  'authenticated cannot select bridge error messages directly'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.bridge_mark_order_failed(uuid,uuid,text,text,boolean)',
    'EXECUTE'
  ),
  'authenticated cannot report bridge failures'
);
select ok(
  not has_function_privilege(
    'anon',
    'public.bridge_mark_order_failed(uuid,uuid,text,text,boolean)',
    'EXECUTE'
  ),
  'anon cannot report bridge failures'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.bridge_mark_order_failed(uuid,uuid,text,text,boolean)',
    'EXECUTE'
  ),
  'service role can report bridge failures'
);
select ok(
  has_function_privilege(
    'authenticated',
    'public.staff_get_order_bridge_failures(uuid[])',
    'EXECUTE'
  ),
  'authenticated may enter the staff failure reader'
);
select ok(
  not has_function_privilege(
    'anon',
    'public.staff_get_order_bridge_failures(uuid[])',
    'EXECUTE'
  ),
  'anon cannot enter the staff failure reader'
);
select ok(
  has_function_privilege(
    'authenticated',
    'public.staff_requeue_order(uuid)',
    'EXECUTE'
  ),
  'authenticated may enter the staff requeue RPC'
);
select ok(
  not has_function_privilege(
    'anon',
    'public.staff_requeue_order(uuid)',
    'EXECUTE'
  ),
  'anon cannot enter the staff requeue RPC'
);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
(
  '10000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'failure-staff@example.invalid', '',
  now(), '{}'::jsonb, '{}'::jsonb, now(), now()
),
(
  '10000000-0000-0000-0000-000000000002',
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'failure-customer@example.invalid', '',
  now(), '{}'::jsonb, '{}'::jsonb, now(), now()
);

insert into public.staff_users (id, role, display_name)
values (
  '10000000-0000-0000-0000-000000000001',
  'staff',
  'Failure Staff'
);

insert into public.companies (id, codcli, name, tarcli)
values (
  '10000000-0000-0000-0000-000000000003',
  900003,
  'Failure Contract Test',
  1
);

insert into public.orders (id, company_id, status, confirmed_at)
values
(
  '10000000-0000-0000-0000-000000000010',
  '10000000-0000-0000-0000-000000000003',
  'confirmed',
  now() - interval '3 minutes'
),
(
  '10000000-0000-0000-0000-000000000011',
  '10000000-0000-0000-0000-000000000003',
  'confirmed',
  now() - interval '2 minutes'
),
(
  '10000000-0000-0000-0000-000000000012',
  '10000000-0000-0000-0000-000000000003',
  'confirmed',
  now() - interval '1 minute'
),
(
  '10000000-0000-0000-0000-000000000013',
  '10000000-0000-0000-0000-000000000003',
  'confirmed',
  now() - interval '30 seconds'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000002","role":"authenticated"}',
  true
);

select throws_ok(
  $$select public.staff_get_order_bridge_failures(
      array['10000000-0000-0000-0000-000000000010'::uuid]
    )$$,
  '42501',
  'STAFF_ONLY',
  'a non-staff authenticated user cannot read bridge failures'
);
select throws_ok(
  $$select public.staff_requeue_order(
      '10000000-0000-0000-0000-000000000010'
    )$$,
  '42501',
  'STAFF_ONLY',
  'a non-staff authenticated user cannot requeue an order'
);

reset role;
set local role service_role;

select is(
  pg_catalog.jsonb_array_length(
    public.bridge_claim_confirmed(
      '10000000-0000-0000-0000-000000000020',
      10,
      300
    )
  ),
  4,
  'bridge claims all four ready fixtures'
);

select is(
  public.bridge_mark_order_failed(
    '10000000-0000-0000-0000-000000000010',
    '10000000-0000-0000-0000-000000000099',
    'WRONG_TOKEN',
    'must not be stored',
    false
  )->>'outcome',
  'stale_claim',
  'a mismatched claim token is rejected'
);
select ok(
  (
    select status = 'processing'
      and bridge_claim_token = '10000000-0000-0000-0000-000000000020'
      and bridge_attempt_count = 1
    from public.orders
    where id = '10000000-0000-0000-0000-000000000010'
  ),
  'a stale failure report does not mutate the order'
);

update public.orders
set
  bridge_attempt_count = 5,
  bridge_claimed_at = now() - interval '10 minutes'
where id = '10000000-0000-0000-0000-000000000013';

select is(
  pg_catalog.jsonb_array_length(
    public.bridge_claim_confirmed(
      '10000000-0000-0000-0000-000000000025',
      10,
      300
    )
  ),
  0,
  'an exhausted stale lease is terminalized instead of reclaimed'
);
select ok(
  (
    select status = 'bridge_failed'
      and bridge_attempt_count = 5
      and bridge_last_error_code = 'LEASE_ATTEMPT_LIMIT'
      and bridge_claim_token is null
    from public.orders
    where id = '10000000-0000-0000-0000-000000000013'
  ),
  'a crash loop at the attempt ceiling enters bridge_failed'
);

select is(
  public.bridge_mark_order_failed(
    '10000000-0000-0000-0000-000000000010',
    '10000000-0000-0000-0000-000000000020',
    'sql_timeout',
    'temporary timeout password=super-secret token=token-value',
    true
  )->>'outcome',
  'requeued',
  'a retryable first failure is scheduled again'
);
select is(
  (
    select bridge_attempt_count
    from public.orders
    where id = '10000000-0000-0000-0000-000000000010'
  ),
  1,
  'the first accepted failure increments the attempt count'
);
select ok(
  (
    select status = 'confirmed'
      and bridge_claim_token is null
      and bridge_claimed_at is null
      and bridge_next_attempt_at > now()
    from public.orders
    where id = '10000000-0000-0000-0000-000000000010'
  ),
  'retry leaves processing and receives a future backoff timestamp'
);
select ok(
  (
    select bridge_last_error_message like '%password=***%'
      and bridge_last_error_message like '%token=***%'
      and bridge_last_error_message not like '%super-secret%'
      and bridge_last_error_message not like '%token-value%'
    from public.orders
    where id = '10000000-0000-0000-0000-000000000010'
  ),
  'failure messages are redacted before they enter the order row'
);
select is(
  pg_catalog.jsonb_array_length(
    public.bridge_claim_confirmed(
      '10000000-0000-0000-0000-000000000021',
      10,
      300
    )
  ),
  0,
  'backoff prevents immediate reclaim while other leases remain live'
);
select ok(
  (
    select not (detail ? 'error_message')
    from public.order_events
    where order_id = '10000000-0000-0000-0000-000000000010'
      and event = 'bridge_retry_scheduled'
  ),
  'failure events never copy the error message'
);

-- Put the second in its fifth cycle. The state constraint requires the prior
-- failure metadata whenever the count is non-zero.
update public.orders
set
  bridge_attempt_count = 5,
  bridge_last_error_code = 'PRIOR_TRANSIENT',
  bridge_failed_at = now()
where id = '10000000-0000-0000-0000-000000000011';

select is(
  public.bridge_mark_order_failed(
    '10000000-0000-0000-0000-000000000011',
    '10000000-0000-0000-0000-000000000020',
    'transient_limit',
    'still transient, but exhausted',
    true
  )->>'outcome',
  'terminal',
  'the fifth retryable failure is terminal'
);
select is(
  (
    select bridge_attempt_count
    from public.orders
    where id = '10000000-0000-0000-0000-000000000011'
  ),
  5,
  'the terminal threshold records attempt five'
);
select ok(
  (
    select status = 'bridge_failed'
      and bridge_claim_token is null
      and bridge_claimed_at is null
      and bridge_next_attempt_at is null
    from public.orders
    where id = '10000000-0000-0000-0000-000000000011'
  ),
  'threshold exhaustion clears the lease and enters bridge_failed'
);

select is(
  public.bridge_mark_order_failed(
    '10000000-0000-0000-0000-000000000012',
    '10000000-0000-0000-0000-000000000020',
    ' all_lines_excluded ',
    repeat('x', 1500),
    false
  )->>'outcome',
  'terminal',
  'a permanent failure enters the terminal state immediately'
);
select is(
  (
    select bridge_last_error_code
    from public.orders
    where id = '10000000-0000-0000-0000-000000000012'
  ),
  'ALL_LINES_EXCLUDED',
  'failure codes are normalized before storage'
);
select is(
  (
    select pg_catalog.length(bridge_last_error_message)
    from public.orders
    where id = '10000000-0000-0000-0000-000000000012'
  ),
  1000,
  'failure messages are capped at one thousand characters'
);
select is(
  pg_catalog.jsonb_array_length(
    public.bridge_claim_confirmed(
      '10000000-0000-0000-0000-000000000022',
      10,
      300
    )
  ),
  0,
  'terminal orders and deferred retries are not claimable'
);

reset role;
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000001","role":"authenticated"}',
  true
);

select is(
  pg_catalog.jsonb_array_length(
    public.staff_get_order_bridge_failures(
      array[
        '10000000-0000-0000-0000-000000000010'::uuid,
        '10000000-0000-0000-0000-000000000011'::uuid,
        '10000000-0000-0000-0000-000000000012'::uuid
      ]
    )
  ),
  3,
  'active staff can read only requested live failure details'
);
select is(
  (
    select pg_catalog.length(entry->>'last_error_message')
    from pg_catalog.jsonb_array_elements(
      public.staff_get_order_bridge_failures(
        array['10000000-0000-0000-0000-000000000012'::uuid]
      )
    ) as result(entry)
  ),
  1000,
  'the staff-only reader returns the stored bounded message'
);
select is(
  public.staff_get_order_bridge_failures(null),
  '[]'::jsonb,
  'the staff failure reader accepts an empty selection'
);
select throws_ok(
  $$select public.staff_get_order_bridge_failures(
      array_fill(
        '10000000-0000-0000-0000-000000000010'::uuid,
        array[101]
      )
    )$$,
  'P0001',
  'TOO_MANY_ORDER_IDS',
  'the staff reader bounds the requested id count'
);
select is(
  public.staff_requeue_order(
    '10000000-0000-0000-0000-000000000011'
  ),
  true,
  'active staff can requeue a terminal order'
);
select ok(
  (
    select status = 'confirmed'
      and bridge_attempt_count = 0
      and bridge_last_error_code is null
      and bridge_last_error_message is null
      and bridge_failed_at is null
      and bridge_next_attempt_at is null
    from public.orders
    where id = '10000000-0000-0000-0000-000000000011'
  ),
  'staff requeue starts a clean attempt cycle'
);
select is(
  public.staff_requeue_order(
    '10000000-0000-0000-0000-000000000011'
  ),
  false,
  'staff cannot requeue an order twice'
);
select ok(
  (
    select detail->>'previous_attempt_count' = '5'
      and detail->>'previous_error_code' = 'TRANSIENT_LIMIT'
      and not (detail ? 'error_message')
    from public.order_events
    where order_id = '10000000-0000-0000-0000-000000000011'
      and event = 'bridge_requeued_by_staff'
  ),
  'the requeue event preserves count and code without message text'
);

reset role;
set local role service_role;

select is(
  pg_catalog.jsonb_array_length(
    public.bridge_claim_confirmed(
      '10000000-0000-0000-0000-000000000023',
      10,
      300
    )
  ),
  1,
  'a staff-requeued order is immediately claimable'
);
select is(
  public.bridge_mark_order_failed(
    '10000000-0000-0000-0000-000000000011',
    '10000000-0000-0000-0000-000000000023',
    'temporary_again',
    'one more transient error',
    true
  )->>'outcome',
  'requeued',
  'the reset order can begin a new retry cycle'
);

update public.orders
set bridge_next_attempt_at = now() - interval '1 second'
where id = '10000000-0000-0000-0000-000000000011';

select is(
  pg_catalog.jsonb_array_length(
    public.bridge_claim_confirmed(
      '10000000-0000-0000-0000-000000000024',
      10,
      300
    )
  ),
  1,
  'a retry becomes claimable after its database backoff elapses'
);
select is(
  public.bridge_mark_injected(
    '10000000-0000-0000-0000-000000000011',
    '10000000-0000-0000-0000-000000000024',
    'B',
    26,
    77777
  ),
  true,
  'a recovered retry can be marked injected'
);
select ok(
  (
    select status = 'injected'
      and bridge_attempt_count = 0
      and bridge_last_error_code is null
      and bridge_last_error_message is null
      and bridge_failed_at is null
      and bridge_next_attempt_at is null
    from public.orders
    where id = '10000000-0000-0000-0000-000000000011'
  ),
  'successful injection clears the live failure cycle'
);

-- Requeue is not the only exit from `bridge_failed`: an order the ERP will
-- never take has to be cancellable, and the cancelled row must satisfy the same
-- state constraint every other row does.
reset role;
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000001","role":"authenticated"}',
  true
);

select is(
  public.staff_cancel_order(
    '10000000-0000-0000-0000-000000000013',
    'el artículo ya no existe en Wingest'
  ),
  true,
  'active staff can cancel an order stuck in bridge_failed'
);
select is(
  public.staff_cancel_order(
    '10000000-0000-0000-0000-000000000011',
    'too late'
  ),
  false,
  'an already-injected order is still not cancellable'
);

reset role;
set local role service_role;

select ok(
  (
    select status = 'cancelled'
      and confirmed_at is null
      and bridge_claim_token is null
      and bridge_claimed_at is null
      and bridge_attempt_count = 0
      and bridge_last_error_code is null
      and bridge_last_error_message is null
      and bridge_failed_at is null
      and bridge_next_attempt_at is null
    from public.orders
    where id = '10000000-0000-0000-0000-000000000013'
  ),
  'cancelling out of bridge_failed clears every live failure field'
);
-- A no-op UPDATE re-evaluates every CHECK constraint on the row, so this is the
-- constraint itself passing judgement on the cancelled state rather than a
-- restatement of the fields asserted above.
select lives_ok(
  $$update public.orders
      set staff_note = staff_note
      where id = '10000000-0000-0000-0000-000000000013'$$,
  'the cancelled row satisfies orders_state_consistency'
);

update public.staff_users
set is_active = false
where id = '10000000-0000-0000-0000-000000000001';

reset role;
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000001","role":"authenticated"}',
  true
);

select throws_ok(
  $$select public.staff_get_order_bridge_failures(
      array['10000000-0000-0000-0000-000000000012'::uuid]
    )$$,
  '42501',
  'STAFF_ONLY',
  'an inactive staff user cannot read bridge failures'
);
select throws_ok(
  $$select public.staff_requeue_order(
      '10000000-0000-0000-0000-000000000012'
    )$$,
  '42501',
  'STAFF_ONLY',
  'an inactive staff user cannot requeue terminal orders'
);

reset role;
select * from finish();
rollback;
