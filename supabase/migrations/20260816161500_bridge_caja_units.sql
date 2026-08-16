-- The bridge learns the caja factor, and create_order's arithmetic gets a roof.
--
-- Task 1 made a portal quantity mean CAJAS and FROZE `units_per_case` on every
-- order line. The bridge is the half that still counts in cajas: it sends
-- `CANPED = CANSER = qty` where Wingest counts bottles. It cannot multiply by a
-- factor it never receives — `bridge_claim_confirmed` enumerates the line
-- columns it emits, and the new one is not among them — so section A adds it.
-- Nothing else about the claim changes: same signature, same lease semantics,
-- same ordering, one more key per item.
--
-- Section B is the review follow-up on the v2 arithmetic that Task 1 shipped.
-- Same formula, same error codes, no behavioural change for any quantity a
-- restaurant can order; what changes is what an ABSURD one does.

-- ---------------------------------------------------------------------------
-- A. bridge_claim_confirmed — the claim carries the factor
-- ---------------------------------------------------------------------------
-- `units_per_case` sits next to `qty` because that is what it is FOR: the two
-- multiply into the base units Wingest wants (`CANPED = CANSER = qty x factor`)
-- while `qty` alone stays the case count (`CAJ`). It is the SNAPSHOT from
-- `order_items`, never a fresh `products` read: a product re-cased between
-- confirmation and injection must not change the pedido the customer agreed to,
-- exactly as `codart`, `unit_price_cents` and `line_total_cents` beside it.
--
-- COALESCE is SQL syntax and cannot be schema-qualified (the note the previous
-- definition carried; it is still true of the two `coalesce` calls below).
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

-- `create or replace` keeps every grant; the block is restated per the repo
-- idiom. The bridge's three functions are service_role ONLY — no other key can
-- lease an order.
revoke all on function public.bridge_claim_confirmed(uuid, integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.bridge_claim_confirmed(uuid, integer, integer)
  to service_role;

-- ---------------------------------------------------------------------------
-- B. create_order v3 — the same arithmetic, with a roof and a wider register
-- ---------------------------------------------------------------------------
-- Two changes, both about what happens ABOVE any real order. Every formula,
-- every error code and the request hash are untouched, so a cart that priced to
-- 46.08 EUR yesterday prices to 46.08 EUR today and a replay still returns the
-- stored order.
--
-- 1. The line total is computed as `bigint`. v2 cast `round(qty x units x price)`
--    straight to `integer`, so the CAST was the thing that failed on a silly
--    quantity — with `integer out of range` (SQLSTATE 22003), a message that
--    names no line, no product and nothing the customer can fix.
-- 2. A per-line bound on the BASE units: `qty x units_per_case > 1000000` is the
--    same `BAD_QTY` every other quantity guard in this loop raises (the client
--    already maps it to "revise las cantidades del carrito"). The number is far
--    past anything a restaurant orders: even at 576, the largest factor in the
--    catalogue today, it is 1,736 cajas of ONE product on ONE line, and the cart
--    cookie itself caps a line at 9,999. What it stops is a hand-made request
--    turning into a raw numeric error from a `::numeric(10,3)` insert cast.
--
-- `v_total` follows `v_line_total` into bigint so the accumulation cannot be the
-- narrow step either. Both still land in `integer` columns, which is deliberate:
-- an order whose subtotal really does not fit an integer is one that must fail,
-- and it fails at the column, after the guards above have had their say.
create or replace function public.create_order(
  p_lines jsonb,
  p_delivery_date date default null,
  p_note text default null,
  p_client_token uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid;
  v_tarcli smallint;
  v_codcli integer;
  v_order_id uuid;
  v_order_number integer;
  v_existing_hash text;
  v_canonical_lines jsonb;
  v_request_hash text;
  v_note text;
  v_today date := (pg_catalog.now() at time zone 'Europe/Madrid')::date;
  v_product public.products%rowtype;
  v_product_id uuid;
  v_qty numeric;
  v_units integer;
  v_price integer;
  v_line_total bigint;
  v_total bigint := 0;
  v_n integer := 0;
  v_constraint text;
begin
  select company.id, company.tarcli, company.codcli
  into v_company, v_tarcli, v_codcli
  from public.portal_users as portal
  join public.companies as company on company.id = portal.company_id
  where portal.id = (select auth.uid())
    and portal.is_active
    and company.is_active;

  if v_company is null then raise exception 'NO_ACTIVE_COMPANY'; end if;
  if v_codcli is null then raise exception 'COMPANY_NOT_LINKED'; end if;
  if p_lines is null
     or pg_catalog.jsonb_typeof(p_lines) <> 'array'
     or pg_catalog.jsonb_array_length(p_lines) = 0 then
    raise exception 'EMPTY_ORDER';
  end if;
  if pg_catalog.jsonb_array_length(p_lines) > 200 then
    raise exception 'TOO_MANY_LINES';
  end if;

  v_note := nullif(pg_catalog.btrim(p_note), '');
  if v_note is not null and pg_catalog.length(v_note) > 2000 then
    raise exception 'NOTE_TOO_LONG';
  end if;
  if p_delivery_date is not null
     and (p_delivery_date < v_today or p_delivery_date > v_today + 60) then
    raise exception 'BAD_DELIVERY_DATE';
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_lines) as source(line)
    where pg_catalog.jsonb_typeof(source.line) <> 'object'
       or source.line->>'product_id' is null
       or source.line->>'qty' is null
  ) then
    raise exception 'BAD_LINE';
  end if;

  begin
    select pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'product_id', parsed.product_id,
        'qty', pg_catalog.trim_scale(parsed.qty)
      )
      order by parsed.product_id::text
    )
    into v_canonical_lines
    from (
      select
        (source.line->>'product_id')::uuid as product_id,
        pg_catalog.sum((source.line->>'qty')::numeric) as qty
      from pg_catalog.jsonb_array_elements(p_lines) as source(line)
      group by (source.line->>'product_id')::uuid
    ) as parsed;
  exception
    when invalid_text_representation or numeric_value_out_of_range then
      raise exception 'BAD_LINE';
  end;

  v_request_hash := pg_catalog.md5(
    pg_catalog.jsonb_build_object(
      'lines', v_canonical_lines,
      'delivery_date', p_delivery_date,
      'note', v_note
    )::text
  );

  if p_client_token is not null then
    select existing.id, existing.order_number, existing.request_hash
    into v_order_id, v_order_number, v_existing_hash
    from public.orders as existing
    where existing.company_id = v_company
      and existing.client_token = p_client_token;

    if found then
      if v_existing_hash is distinct from v_request_hash then
        raise exception 'IDEMPOTENCY_MISMATCH' using errcode = '22023';
      end if;
      return pg_catalog.jsonb_build_object(
        'order_id', v_order_id,
        'order_number', v_order_number,
        'duplicate', true
      );
    end if;
  end if;

  insert into public.orders (
    company_id, placed_by, delivery_date, customer_note, client_token, request_hash
  )
  values (
    v_company, (select auth.uid()), p_delivery_date, v_note,
    p_client_token, v_request_hash
  )
  returning id, order_number into v_order_id, v_order_number;

  for v_product_id, v_qty in
    select line.product_id, line.qty
    from pg_catalog.jsonb_to_recordset(v_canonical_lines)
      as line(product_id uuid, qty numeric)
  loop
    if v_qty is null
       or v_qty::text = 'NaN'
       or v_qty <= 0
       or pg_catalog.scale(v_qty) > 3 then
      raise exception 'BAD_QTY';
    end if;

    select product.*
    into v_product
    from public.products as product
    where product.id = v_product_id
      and product.is_orderable;

    if not found then raise exception 'PRODUCT_UNAVAILABLE:%', v_product_id; end if;
    if not v_product.is_weighed and v_qty <> pg_catalog.trunc(v_qty) then
      raise exception 'BAD_QTY_STEP:%', v_product.codart;
    end if;

    v_price := public.price_cents_for(v_product, v_tarcli);
    if v_price is null or v_price <= 0 then
      raise exception 'NO_PRICE:%:tier %', v_product.codart, v_tarcli;
    end if;

    -- NOT NULL and >= 1 by column constraint, so this needs no guard: the
    -- weighed case (fractional qty) is factor 1 and multiplies out unchanged.
    v_units := v_product.units_per_case;
    -- The line in BASE units is what the bridge will send Wingest as
    -- CANPED/CANSER, so the roof belongs on the product, not on `v_qty` alone:
    -- 9,999 cajas of a 576-per-caja article is 5.7 million bottles.
    if v_qty * v_units > 1000000 then
      raise exception 'BAD_QTY';
    end if;
    -- `round` survives from v1 for the weighed future only: with integer cajas
    -- every operand is an integer and there is nothing to round.
    v_line_total := pg_catalog.round(v_qty * v_units * v_price)::bigint;
    v_n := v_n + 1;
    insert into public.order_items (
      order_id, product_id, codart, name, qty, unit, units_per_case,
      unit_price_cents, line_total_cents, is_weighed, is_erp_excluded, sort_order
    )
    values (
      v_order_id, v_product.id, v_product.codart, v_product.name,
      v_qty::numeric(10,3), v_product.unit, v_units, v_price, v_line_total,
      v_product.is_weighed, v_product.is_erp_excluded, v_n
    );
    v_total := v_total + v_line_total;
  end loop;

  update public.orders set subtotal_cents = v_total where id = v_order_id;
  insert into public.order_events (order_id, event, actor)
  values (v_order_id, 'submitted', (select auth.uid()));

  return pg_catalog.jsonb_build_object(
    'order_id', v_order_id,
    'order_number', v_order_number
  );
exception
  when unique_violation then
    get stacked diagnostics v_constraint = constraint_name;
    if p_client_token is not null and v_constraint = 'orders_client_token' then
      select existing.id, existing.order_number, existing.request_hash
      into v_order_id, v_order_number, v_existing_hash
      from public.orders as existing
      where existing.company_id = v_company
        and existing.client_token = p_client_token;

      if v_order_id is not null then
        if v_existing_hash is distinct from v_request_hash then
          raise exception 'IDEMPOTENCY_MISMATCH' using errcode = '22023';
        end if;
        return pg_catalog.jsonb_build_object(
          'order_id', v_order_id,
          'order_number', v_order_number,
          'duplicate', true
        );
      end if;
    end if;
    raise;
end
$$;

revoke all on function public.create_order(jsonb, date, text, uuid)
  from public, anon, authenticated;
grant execute on function public.create_order(jsonb, date, text, uuid)
  to authenticated, service_role;
