-- Confirm the selected portal orders in one short database transaction.
--
-- This is deliberately a portal state transition only.  The bridge remains the
-- sole process that can claim `confirmed` orders and write them to Wingest.
create function public.staff_bulk_confirm_orders(p_order_ids uuid[])
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ids uuid[];
  v_confirmed uuid[];
  v_actor uuid := (select auth.uid());
  v_requested_count integer;
  v_confirmed_count integer;
begin
  if not private.is_staff() then
    raise exception 'STAFF_ONLY' using errcode = '42501';
  end if;

  -- Bound the raw request before de-duplicating it.  Besides keeping one click
  -- cheap, this prevents a caller from hiding an arbitrarily large payload
  -- behind repeated ids.  The queue itself shows at most fifty orders.
  if p_order_ids is null
    or pg_catalog.cardinality(p_order_ids) < 1
    or pg_catalog.cardinality(p_order_ids) > 50
    or pg_catalog.array_position(p_order_ids, null) is not null
  then
    raise exception 'BAD_ORDER_IDS' using errcode = '22023';
  end if;

  -- De-duplicate while retaining first-request order for the result arrays.
  select pg_catalog.array_agg(input.id order by input.first_position)
  into v_ids
  from (
    select candidate.id, pg_catalog.min(candidate.position) as first_position
    from pg_catalog.unnest(p_order_ids)
      with ordinality as candidate(id, position)
    group by candidate.id
  ) as input;

  v_requested_count := pg_catalog.cardinality(v_ids);

  -- Lock eligible rows in UUID order.  Every bulk call takes overlapping locks
  -- in the same order, and the status is rechecked after any wait.  The UPDATE
  -- and its audit INSERT are data-modifying CTEs in this one statement: an
  -- error in either rolls the entire selection back.
  with locked as materialized (
    select queued.id
    from public.orders as queued
    where queued.id = any(v_ids)
      and queued.status = 'submitted'
    order by queued.id
    for update
  ),
  updated as (
    update public.orders as queued
    set
      status = 'confirmed',
      confirmed_at = pg_catalog.now()
    from locked
    where queued.id = locked.id
      and queued.status = 'submitted'
    returning queued.id
  ),
  evented as (
    insert into public.order_events (order_id, event, actor)
    select updated.id, 'confirmed', v_actor
    from updated
    returning order_id
  )
  select pg_catalog.coalesce(
    pg_catalog.array_agg(evented.order_id order by evented.order_id),
    '{}'::uuid[]
  )
  into v_confirmed
  from evented;

  v_confirmed_count := pg_catalog.cardinality(v_confirmed);

  return pg_catalog.jsonb_build_object(
    'requested_count', v_requested_count,
    'confirmed_count', v_confirmed_count,
    'skipped_count', v_requested_count - v_confirmed_count,
    'confirmed_ids', (
      select pg_catalog.coalesce(
        pg_catalog.jsonb_agg(input.id order by input.position),
        '[]'::jsonb
      )
      from pg_catalog.unnest(v_ids)
        with ordinality as input(id, position)
      where input.id = any(v_confirmed)
    ),
    'skipped_ids', (
      select pg_catalog.coalesce(
        pg_catalog.jsonb_agg(input.id order by input.position),
        '[]'::jsonb
      )
      from pg_catalog.unnest(v_ids)
        with ordinality as input(id, position)
      where not (input.id = any(v_confirmed))
    )
  );
end
$$;

revoke all on function public.staff_bulk_confirm_orders(uuid[])
  from public, anon, authenticated;
grant execute on function public.staff_bulk_confirm_orders(uuid[])
  to authenticated, service_role;
