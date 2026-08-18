-- A bounded, observable failure state for the on-prem bridge.
--
-- A failed claimed order must leave `processing` atomically. Transient failures
-- are returned to `confirmed` behind a database-owned backoff; permanent errors
-- and the fifth reported failure enter `bridge_failed` until an active staff
-- user explicitly requeues them. Error messages remain staff-only: customers
-- can read their order row, so the columns are deliberately omitted from the
-- authenticated column grants and exposed through a checked RPC instead.

alter table public.orders
  add column bridge_attempt_count integer not null default 0,
  add column bridge_last_error_code text,
  add column bridge_last_error_message text,
  add column bridge_failed_at timestamptz,
  add column bridge_next_attempt_at timestamptz;

alter table public.orders
  drop constraint orders_status_check,
  drop constraint orders_state_consistency;

-- A row already leased by the pre-hardening claim RPC has no attempt count: the
-- column is being added right now with a default of 0, and the constraint below
-- requires a claimed row to have consumed at least one attempt. One is true of
-- every such row — it was claimed at least once — so heal them before the
-- constraint is added rather than failing the migration on live data.
update public.orders
set bridge_attempt_count = 1
where status = 'processing'
  and bridge_attempt_count = 0;

alter table public.orders
  add constraint orders_status_check
    check (status in (
      'submitted', 'confirmed', 'processing', 'bridge_failed',
      'injected', 'albaran', 'cancelled'
    )),
  add constraint orders_bridge_attempt_count_range
    check (bridge_attempt_count between 0 and 5),
  add constraint orders_bridge_error_code_length
    check (
      bridge_last_error_code is null
      or pg_catalog.length(bridge_last_error_code) between 1 and 100
    ),
  add constraint orders_bridge_error_message_length
    check (
      bridge_last_error_message is null
      or pg_catalog.length(bridge_last_error_message) <= 1000
    ),
  add constraint orders_state_consistency check (
    ((status in ('confirmed', 'processing', 'bridge_failed', 'injected', 'albaran'))
      = (confirmed_at is not null))
    and ((status = 'processing')
      = (bridge_claim_token is not null and bridge_claimed_at is not null))
    and ((bridge_claim_token is null) = (bridge_claimed_at is null))
    and ((status in ('injected', 'albaran'))
      = (numped is not null and injected_at is not null))
    and ((status = 'albaran')
      = (numalb is not null and albaran_at is not null))
    -- `processing` is the one state where a non-zero attempt count carries no
    -- error: `bridge_claim_confirmed` consumes the attempt when it takes the
    -- lease, before anything can have gone wrong. Outside that state the pair
    -- moves together, and inside it the count is always a real claim.
    and (
      status = 'processing'
      or ((bridge_attempt_count = 0) = (bridge_last_error_code is null))
    )
    and (status <> 'processing' or bridge_attempt_count between 1 and 5)
    and ((bridge_last_error_code is null) = (bridge_failed_at is null))
    and (bridge_last_error_message is null or bridge_last_error_code is not null)
    and (bridge_next_attempt_at is null or (
      status = 'confirmed' and bridge_attempt_count > 0
    ))
    and (status <> 'bridge_failed' or (
      bridge_attempt_count > 0
      and bridge_last_error_code is not null
      and bridge_failed_at is not null
      and bridge_next_attempt_at is null
    ))
    and (status not in ('submitted', 'cancelled', 'injected', 'albaran') or (
      bridge_attempt_count = 0
      and bridge_last_error_code is null
      and bridge_last_error_message is null
      and bridge_failed_at is null
      and bridge_next_attempt_at is null
    ))
  );

drop index public.orders_open;
create index orders_open on public.orders(status)
  where status in ('submitted', 'confirmed', 'processing', 'bridge_failed');

drop index public.orders_bridge_claim;
create index orders_bridge_confirmed_queue
  on public.orders(confirmed_at, order_number)
  include (bridge_next_attempt_at)
  where status = 'confirmed';
create index orders_bridge_processing_lease
  on public.orders(bridge_claimed_at, confirmed_at, order_number)
  where status = 'processing';

-- Preserve the current claim payload (including units_per_case) while excluding
-- confirmed rows whose retry delay has not elapsed. Taking a claim clears only
-- the scheduling timestamp; the preceding error remains visible until success
-- or a staff reset, and its durable event remains afterwards.
create or replace function public.bridge_claim_confirmed(
  p_claim_token uuid,
  p_limit integer default 50,
  p_lease_seconds integer default 300
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  if p_claim_token is null then raise exception 'CLAIM_TOKEN_REQUIRED'; end if;
  if p_limit < 1 or p_limit > 200 then raise exception 'BAD_CLAIM_LIMIT'; end if;
  if p_lease_seconds < 30 or p_lease_seconds > 3600 then
    raise exception 'BAD_LEASE_SECONDS';
  end if;

  with lease_exhausted as (
    update public.orders
    set
      status = 'bridge_failed',
      bridge_claim_token = null,
      bridge_claimed_at = null,
      bridge_failed_at = pg_catalog.now(),
      bridge_last_error_code = 'LEASE_ATTEMPT_LIMIT',
      bridge_last_error_message =
        'Processing lease expired after the maximum number of attempts',
      bridge_next_attempt_at = null
    where status = 'processing'
      and bridge_claimed_at
        < pg_catalog.now() - pg_catalog.make_interval(secs => p_lease_seconds)
      and bridge_attempt_count >= 5
    returning id
  ),
  lease_evented as (
    insert into public.order_events (order_id, event, detail)
    select
      exhausted.id,
      'bridge_failed',
      pg_catalog.jsonb_build_object(
        'error_code', 'LEASE_ATTEMPT_LIMIT',
        'attempt_count', 5,
        'retryable', true
      )
    from lease_exhausted as exhausted
    returning order_id
  ),
  picked as (
    select queued.id
    from public.orders as queued
    join public.companies as company on company.id = queued.company_id
    where company.codcli is not null
      and (
        (
          queued.status = 'confirmed'
          and (
            queued.bridge_next_attempt_at is null
            or queued.bridge_next_attempt_at <= pg_catalog.now()
          )
        )
        or (
          queued.status = 'processing'
          and queued.bridge_claimed_at
            < pg_catalog.now() - pg_catalog.make_interval(secs => p_lease_seconds)
        )
      )
      and not exists (
        select 1
        from lease_exhausted
        where lease_exhausted.id = queued.id
      )
    order by queued.confirmed_at, queued.order_number
    limit p_limit
    for update of queued skip locked
  ),
  claimed as (
    update public.orders as target
    set
      status = 'processing',
      bridge_claim_token = p_claim_token,
      bridge_claimed_at = pg_catalog.now(),
      bridge_attempt_count = pg_catalog.least(target.bridge_attempt_count + 1, 5),
      bridge_next_attempt_at = null
    from picked
    where target.id = picked.id
    returning target.*
  ),
  evented as (
    insert into public.order_events (order_id, event, detail)
    select
      claimed.id,
      'bridge_claimed',
      pg_catalog.jsonb_build_object(
        'claim_token', p_claim_token,
        'attempt_number', claimed.bridge_attempt_count
      )
    from claimed
    returning order_id
  )
  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'id', claimed.id,
        'order_number', claimed.order_number,
        'claim_token', claimed.bridge_claim_token,
        'delivery_date', claimed.delivery_date,
        'customer_note', claimed.customer_note,
        'subtotal_cents', claimed.subtotal_cents,
        'codcli', company.codcli,
        'tarcli', company.tarcli,
        'company_name', company.name,
        'items', coalesce(
          (
            select pg_catalog.jsonb_agg(
              pg_catalog.jsonb_build_object(
                'codart', item.codart,
                'qty', item.qty,
                'units_per_case', item.units_per_case,
                'unit_price_cents', item.unit_price_cents,
                'line_total_cents', item.line_total_cents,
                'is_weighed', item.is_weighed,
                'is_erp_excluded', item.is_erp_excluded
              )
              order by item.sort_order
            )
            from public.order_items as item
            where item.order_id = claimed.id
          ),
          '[]'::jsonb
        )
      )
      order by claimed.confirmed_at, claimed.order_number
    ),
    '[]'::jsonb
  )
  into v_result
  from claimed
  join public.companies as company on company.id = claimed.company_id;

  return v_result;
end
$$;

-- The token check and transition happen in the same UPDATE. Attempt count is
-- consumed when a claim is created, including a stale-lease reclaim, so a
-- worker that crashes before reporting its outcome cannot retry forever.
-- Four transient failures are scheduled at 1, 2, 4 and 8 minutes; the fifth is
-- terminal even when the caller still classifies it as retryable.
create function public.bridge_mark_order_failed(
  p_order_id uuid,
  p_claim_token uuid,
  p_error_code text,
  p_error_message text,
  p_retryable boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_code text := pg_catalog.upper(
    coalesce(nullif(pg_catalog.btrim(p_error_code), ''), 'UNKNOWN_ERROR')
  );
  v_message text := nullif(
    pg_catalog.left(
      pg_catalog.regexp_replace(
        pg_catalog.regexp_replace(
          pg_catalog.regexp_replace(
            pg_catalog.btrim(coalesce(p_error_message, '')),
            '(?i)(password|passwd|pwd|secret|token|api[_-]?key|service[_-]?role)([[:space:]]*[:=][[:space:]]*)[^[:space:];,]+',
            E'\\1\\2***',
            'g'
          ),
          '(?i)(postgres|postgresql|mssql|sqlserver)://[^[:space:]]+',
          '***',
          'g'
        ),
        '(?i)(Bearer[[:space:]]+)[^[:space:]]+',
        E'\\1***',
        'g'
      ),
      1000
    ),
    ''
  );
  v_attempt integer;
  v_status text;
  v_next_attempt_at timestamptz;
  v_outcome text;
begin
  v_code := pg_catalog.left(v_code, 100);

  if p_order_id is null or p_claim_token is null then
    return pg_catalog.jsonb_build_object(
      'marked', false,
      'outcome', 'stale_claim',
      'attempt_count', null,
      'next_attempt_at', null
    );
  end if;

  update public.orders
  set
    bridge_attempt_count = pg_catalog.greatest(bridge_attempt_count, 1),
    bridge_last_error_code = v_code,
    bridge_last_error_message = v_message,
    bridge_failed_at = pg_catalog.now(),
    status = case
      when coalesce(p_retryable, false)
        and pg_catalog.greatest(bridge_attempt_count, 1) < 5
        then 'confirmed'
      else 'bridge_failed'
    end,
    bridge_next_attempt_at = case
      when coalesce(p_retryable, false)
        and pg_catalog.greatest(bridge_attempt_count, 1) < 5
        then pg_catalog.now() + pg_catalog.make_interval(
          secs => (
            60 * pg_catalog.power(
              2::numeric,
              pg_catalog.greatest(bridge_attempt_count, 1) - 1
            )
          )::integer
        )
      else null
    end,
    bridge_claim_token = null,
    bridge_claimed_at = null
  where id = p_order_id
    and status = 'processing'
    and bridge_claim_token = p_claim_token
  returning
    bridge_attempt_count,
    status,
    bridge_next_attempt_at
  into v_attempt, v_status, v_next_attempt_at;

  if not found then
    return pg_catalog.jsonb_build_object(
      'marked', false,
      'outcome', 'stale_claim',
      'attempt_count', null,
      'next_attempt_at', null
    );
  end if;

  v_outcome := case when v_status = 'confirmed' then 'requeued' else 'terminal' end;

  insert into public.order_events (order_id, event, detail)
  values (
    p_order_id,
    case when v_status = 'confirmed'
      then 'bridge_retry_scheduled'
      else 'bridge_failed'
    end,
    pg_catalog.jsonb_strip_nulls(
      pg_catalog.jsonb_build_object(
        'error_code', v_code,
        'attempt_count', v_attempt,
        'retryable', coalesce(p_retryable, false),
        'next_attempt_at', v_next_attempt_at
      )
    )
  );

  return pg_catalog.jsonb_build_object(
    'marked', true,
    'outcome', v_outcome,
    'attempt_count', v_attempt,
    'next_attempt_at', v_next_attempt_at
  );
end
$$;

-- A successful ERP write closes the current failure cycle. Historical failure
-- codes and counts remain in order_events, but no stale failure is shown on an
-- injected order.
create or replace function public.bridge_mark_injected(
  p_order_id uuid,
  p_claim_token uuid,
  p_numped integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_claim_token is null or p_numped is null or p_numped <= 0 then
    return false;
  end if;

  update public.orders
  set
    status = 'injected',
    numped = p_numped,
    injected_at = pg_catalog.now(),
    bridge_claim_token = null,
    bridge_claimed_at = null,
    bridge_attempt_count = 0,
    bridge_last_error_code = null,
    bridge_last_error_message = null,
    bridge_failed_at = null,
    bridge_next_attempt_at = null
  where id = p_order_id
    and status = 'processing'
    and bridge_claim_token = p_claim_token;

  if not found then return false; end if;
  insert into public.order_events (order_id, event, detail)
  values (
    p_order_id,
    'injected',
    pg_catalog.jsonb_build_object('numped', p_numped)
  );
  return true;
end
$$;

-- Error columns are intentionally not granted to authenticated. This bounded
-- RPC is the only customer-key path to them and rechecks active staff status.
create function public.staff_get_order_bridge_failures(p_order_ids uuid[])
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  if not private.is_staff() then
    raise exception 'STAFF_ONLY' using errcode = '42501';
  end if;
  if p_order_ids is null or pg_catalog.cardinality(p_order_ids) = 0 then
    return '[]'::jsonb;
  end if;
  if pg_catalog.cardinality(p_order_ids) > 100 then
    raise exception 'TOO_MANY_ORDER_IDS';
  end if;

  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'order_id', source.id,
        'status', source.status,
        'attempt_count', source.bridge_attempt_count,
        'last_error_code', source.bridge_last_error_code,
        'last_error_message', source.bridge_last_error_message,
        'failed_at', source.bridge_failed_at,
        'next_attempt_at', source.bridge_next_attempt_at
      )
      order by source.order_number
    ),
    '[]'::jsonb
  )
  into v_result
  from public.orders as source
  where source.id = any(p_order_ids)
    and source.bridge_last_error_code is not null;

  return v_result;
end
$$;

-- Requeue starts a fresh five-attempt cycle. The old count/code is copied to an
-- append-only event before the live fields are cleared; messages are never put
-- in order_events because customers may gain event visibility in the future.
create function public.staff_requeue_order(p_order_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_previous_attempts integer;
  v_previous_code text;
begin
  if not private.is_staff() then
    raise exception 'STAFF_ONLY' using errcode = '42501';
  end if;
  if p_order_id is null then return false; end if;

  select source.bridge_attempt_count, source.bridge_last_error_code
  into v_previous_attempts, v_previous_code
  from public.orders as source
  where source.id = p_order_id
    and source.status = 'bridge_failed'
  for update;

  if not found then return false; end if;

  update public.orders
  set
    status = 'confirmed',
    bridge_claim_token = null,
    bridge_claimed_at = null,
    bridge_attempt_count = 0,
    bridge_last_error_code = null,
    bridge_last_error_message = null,
    bridge_failed_at = null,
    bridge_next_attempt_at = null
  where id = p_order_id;

  insert into public.order_events (order_id, event, detail, actor)
  values (
    p_order_id,
    'bridge_requeued_by_staff',
    pg_catalog.jsonb_build_object(
      'previous_attempt_count', v_previous_attempts,
      'previous_error_code', v_previous_code
    ),
    (select auth.uid())
  );

  return true;
end
$$;

-- Requeue is not the only way out of `bridge_failed`. An order the ERP will
-- never accept — a deleted article, a customer closed in Wingest — has to be
-- cancellable, or the queue keeps a row nobody can act on.
--
-- Cancelling clears the whole live failure cycle because the constraint above
-- requires it: a cancelled row carries no attempt count, no error and no lease.
-- None of that is lost — `order_events` already holds every failure this order
-- collected, and this transition appends the state it came from.
create or replace function public.staff_cancel_order(
  p_order_id uuid,
  p_reason text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reason text := nullif(pg_catalog.btrim(p_reason), '');
  v_previous_status text;
begin
  if not private.is_staff() then
    raise exception 'STAFF_ONLY' using errcode = '42501';
  end if;
  if v_reason is not null and pg_catalog.length(v_reason) > 2000 then
    raise exception 'NOTE_TOO_LONG';
  end if;

  select source.status
  into v_previous_status
  from public.orders as source
  where source.id = p_order_id
    and source.status in ('submitted', 'bridge_failed')
  for update;

  if not found then return false; end if;

  update public.orders
  set
    status = 'cancelled',
    staff_note = v_reason,
    -- The constraint reads confirmed_at as "this order stands confirmed", so a
    -- cancelled row cannot keep one. The durable record of the confirmation is
    -- its append-only `confirmed` event, which this does not touch.
    confirmed_at = null,
    bridge_claim_token = null,
    bridge_claimed_at = null,
    bridge_attempt_count = 0,
    bridge_last_error_code = null,
    bridge_last_error_message = null,
    bridge_failed_at = null,
    bridge_next_attempt_at = null
  where id = p_order_id;

  insert into public.order_events (order_id, event, detail, actor)
  values (
    p_order_id,
    'cancelled',
    -- The reason is staff-written text and the previous status is a state
    -- name; neither is an ERP error message, which never enters this table.
    pg_catalog.jsonb_strip_nulls(
      pg_catalog.jsonb_build_object(
        'reason', v_reason,
        'previous_status', v_previous_status
      )
    ),
    (select auth.uid())
  );
  return true;
end
$$;

-- The table is customer-readable through column grants. Keep operational errors
-- private even if a future migration broadens another order column grant.
revoke select (
  bridge_attempt_count,
  bridge_last_error_code,
  bridge_last_error_message,
  bridge_failed_at,
  bridge_next_attempt_at
) on public.orders from public, anon, authenticated;

revoke all on function public.bridge_claim_confirmed(uuid, integer, integer)
  from public, anon, authenticated, service_role;
revoke all on function public.bridge_mark_order_failed(uuid, uuid, text, text, boolean)
  from public, anon, authenticated, service_role;
revoke all on function public.bridge_mark_injected(uuid, uuid, integer)
  from public, anon, authenticated, service_role;
revoke all on function public.staff_get_order_bridge_failures(uuid[])
  from public, anon, authenticated, service_role;
revoke all on function public.staff_requeue_order(uuid)
  from public, anon, authenticated, service_role;
-- `create or replace` keeps the existing ACL, so this restates it rather than
-- changing it: the RPC is entered with the caller's own key and re-checks
-- `private.is_staff()` itself.
revoke all on function public.staff_cancel_order(uuid, text)
  from public, anon, authenticated, service_role;

grant execute on function public.bridge_claim_confirmed(uuid, integer, integer)
  to service_role;
grant execute on function public.bridge_mark_order_failed(uuid, uuid, text, text, boolean)
  to service_role;
grant execute on function public.bridge_mark_injected(uuid, uuid, integer)
  to service_role;
grant execute on function public.staff_get_order_bridge_failures(uuid[])
  to authenticated;
grant execute on function public.staff_requeue_order(uuid)
  to authenticated;
grant execute on function public.staff_cancel_order(uuid, text)
  to authenticated, service_role;
