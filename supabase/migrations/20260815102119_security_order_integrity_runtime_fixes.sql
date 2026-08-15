-- COALESCE is SQL syntax and cannot be schema-qualified.
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

  with picked as (
    select queued.id
    from public.orders as queued
    join public.companies as company on company.id = queued.company_id
    where company.codcli is not null
      and (
        queued.status = 'confirmed'
        or (
          queued.status = 'processing'
          and queued.bridge_claimed_at
            < pg_catalog.now() - pg_catalog.make_interval(secs => p_lease_seconds)
        )
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
      bridge_claimed_at = pg_catalog.now()
    from picked
    where target.id = picked.id
    returning target.*
  ),
  evented as (
    insert into public.order_events (order_id, event, detail)
    select
      claimed.id,
      'bridge_claimed',
      pg_catalog.jsonb_build_object('claim_token', p_claim_token)
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

revoke all on function public.bridge_claim_confirmed(uuid, integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.bridge_claim_confirmed(uuid, integer, integer)
  to service_role;
