-- Allow recovery tooling to lease one known historical order without consuming
-- unrelated ready work. NULL preserves the ordinary FIFO batch behavior.

drop function public.bridge_claim_confirmed(uuid, integer, integer);

create index orders_bridge_processing_token
  on public.orders(
    bridge_claim_token,
    bridge_claimed_at,
    confirmed_at,
    order_number
  )
  where status = 'processing';

create function public.bridge_claim_confirmed(
  p_claim_token uuid,
  p_limit integer default 50,
  p_lease_seconds integer default 300,
  p_order_id uuid default null
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
  if p_limit is null or p_limit < 1 or p_limit > 200 then
    raise exception 'BAD_CLAIM_LIMIT';
  end if;
  if p_lease_seconds is null
     or p_lease_seconds < 30
     or p_lease_seconds > 3600 then
    raise exception 'BAD_LEASE_SECONDS';
  end if;

  -- The HTTP client retries one ambiguous network failure with the exact same
  -- body. Serialize that token so a committed first response can be replayed
  -- instead of silently claiming a second FIFO batch.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_claim_token::pg_catalog.text, 0)
  );

  -- A targeted claim is also the supervised historical-recovery path. Lock the
  -- row *before* testing its state, without SKIP LOCKED: if an identical HTTP
  -- retry arrives while the first request is committing, it must wait and then
  -- observe that committed lease instead of returning a misleading empty list.
  if p_order_id is not null then
    perform 1
    from public.orders as target_lock
    where target_lock.id = p_order_id
    for update;
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
      and (p_order_id is null or id = p_order_id)
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
  replayed as materialized (
    select owned.id
    from public.orders as owned
    where owned.status = 'processing'
      and owned.bridge_claim_token = p_claim_token
      and owned.bridge_claimed_at >=
        pg_catalog.now() - pg_catalog.make_interval(secs => p_lease_seconds)
      and (p_order_id is null or owned.id = p_order_id)
    order by owned.confirmed_at, owned.order_number
    limit p_limit
  ),
  picked as (
    select queued.id
    from public.orders as queued
    join public.companies as company on company.id = queued.company_id
    where not exists (select 1 from replayed)
      and (p_order_id is null or queued.id = p_order_id)
      and company.codcli is not null
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
  newly_claimed as (
    update public.orders as target
    set
      status = 'processing',
      bridge_claim_token = p_claim_token,
      bridge_claimed_at = pg_catalog.now(),
      -- Unqualified on purpose: LEAST is SQL syntax with no pg_proc entry, so
      -- `pg_catalog.least` resolves to nothing at run time. See the longer note
      -- in 20260817100000 and the COALESCE precedent in 20260815102119.
      bridge_attempt_count = least(target.bridge_attempt_count + 1, 5),
      bridge_next_attempt_at = null
    from picked
    where target.id = picked.id
    returning target.*
  ),
  evented as (
    insert into public.order_events (order_id, event, detail)
    select
      newly_claimed.id,
      'bridge_claimed',
      pg_catalog.jsonb_build_object(
        'claim_token', p_claim_token,
        'attempt_number', newly_claimed.bridge_attempt_count
      )
    from newly_claimed
    returning order_id
  ),
  claimed as (
    select target.*
    from public.orders as target
    join replayed on replayed.id = target.id
    union all
    -- A data-modifying CTE's writes are not visible through a sibling base-table
    -- scan in the same statement. RETURNING is the authoritative post-update
    -- row, including the fresh claim token and timestamp.
    select newly_claimed.*
    from newly_claimed
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

revoke all on function public.bridge_claim_confirmed(
  uuid, integer, integer, uuid
) from public, anon, authenticated, service_role;
grant execute on function public.bridge_claim_confirmed(
  uuid, integer, integer, uuid
) to service_role;
