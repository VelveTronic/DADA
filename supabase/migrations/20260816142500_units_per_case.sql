-- Portal quantities mean CAJAS.
--
-- `units_per_case` is the integer factor (Wingest `articulo.UNILOT`) that turns
-- one caja into the base units the ERP counts, and it is the single place the
-- two systems' arithmetic meets: the portal keeps qty = cajas and prices per
-- caja, Wingest keeps qty = bottles and prices per bottle, and the factor is
-- what makes the two totals the same number.
--
-- Every money step below is MULTIPLICATION of integer cents by an integer
-- factor. There is no division anywhere, so no total can be a rounded opinion of
-- another one.

-- ---------------------------------------------------------------------------
-- A. products.units_per_case becomes a real factor
-- ---------------------------------------------------------------------------
-- The column already existed as a nullable `numeric(10,3)` that the price merge
-- wrote and nothing read. It now carries money-grade meaning, so it becomes what
-- that requires: an integer >= 1 that is never null. NOT NULL is the load-bearing
-- half — with it, `price_cents * units_per_case` needs no "unknown factor" branch
-- anywhere in the view, the RPC or the app.
--
-- The view projects the column, so it is dropped here and rebuilt in section C.
drop view public.products_priced;

alter table public.products
  drop constraint products_units_per_case_pos;

-- The conversion is the SAME rule `toWingestPricePatch` now applies to UNILOT,
-- so rows the nightly price-sync has not reached yet already read the way it will
-- write them. Anything that is not a whole number >= 1 — NULL (the 2,080 rows the
-- merge never set), 0 and negatives ("not sold by the case" in ERP data), and the
-- 33 fractional values `articulo` actually holds — means "the caja IS the unit"
-- and becomes 1. A wrong factor would silently multiply a price, so the fallback
-- is the one value that changes nothing.
alter table public.products
  alter column units_per_case type integer
    using case
      when units_per_case is null then 1
      when units_per_case < 1 then 1
      when units_per_case <> trunc(units_per_case) then 1
      else units_per_case::integer
    end;

alter table public.products
  alter column units_per_case set default 1,
  alter column units_per_case set not null,
  add constraint products_units_per_case_pos check (units_per_case >= 1);

-- ---------------------------------------------------------------------------
-- B. order_items.units_per_case — the factor the order was priced with
-- ---------------------------------------------------------------------------
-- Snapshotted per line, like `codart`, `name`, `unit` and `unit_price_cents`
-- already are: a product re-cased from 12 to 24 next month must not change what
-- an order placed today says it charged.
--
-- DEFAULT 1 is what keeps the orders placed before this migration true. They were
-- injected into Wingest 1:1, so their stored `line_total_cents` really is
-- `qty x unit_price_cents` — which is exactly what the new formula computes when
-- the factor is 1.
alter table public.order_items
  add column units_per_case integer not null default 1
    constraint order_items_units_per_case_pos check (units_per_case >= 1);

-- ---------------------------------------------------------------------------
-- C. products_priced — one place where the caja price is computed
-- ---------------------------------------------------------------------------
-- `price_per_case_cents` is derived HERE rather than in the app so that no client
-- ever multiplies money. Customer pages read this column and print it; the cart's
-- own arithmetic multiplies it by a quantity and nothing else.
--
-- The six-tier ladder is a LATERAL rather than written out twice: two copies is
-- two places for a tier to be mistyped, and the per-caja price has to be exactly
-- `price_cents x units_per_case` of the SAME row, not a second opinion about which
-- tier this company sits on. It stays an inlined CASE rather than a call to
-- `price_cents_for` for the reason the previous migration gives: authenticated
-- callers must not need EXECUTE on it.
--
-- bigint, not integer: the factor is whatever UNILOT holds, and an overflow in a
-- view fails the WHOLE catalogue query — every product on the page — rather than
-- one row. Values stay exact well inside what JSON can carry.
create view public.products_priced as
select
  product.id, product.codart, product.base_sku, product.variant_suffix,
  product.name, product.category_id, product.unit, product.units_per_case,
  product.is_weighed, product.is_erp_excluded, product.is_available,
  product.is_current_variant, product.is_orderable, product.iva_rate,
  product.image_url, product.sort_order,
  tarifa.price_cents,
  tarifa.price_cents::bigint * product.units_per_case as price_per_case_cents
from public.products as product
join public.companies as company
  on company.id = private.my_company_id()
cross join lateral (
  select case company.tarcli
    when 1 then product.price_1_cents
    when 2 then product.price_2_cents
    when 3 then product.price_3_cents
    when 4 then product.price_4_cents
    when 5 then product.price_5_cents
    when 6 then product.price_6_cents
  end as price_cents
) as tarifa;

-- Grants do not survive a DROP VIEW, so the definer view's whole access story is
-- restated here exactly as `security_order_integrity` set it: nothing for public
-- or anon, SELECT for authenticated (the six price_N_cents columns are reachable
-- through this view and NOWHERE else), everything for the service role.
revoke all on public.products_priced from public, anon, authenticated;
grant select on public.products_priced to authenticated;
grant all privileges on public.products_priced to service_role;

-- ---------------------------------------------------------------------------
-- D. create_order v2 — a line total counts base units
-- ---------------------------------------------------------------------------
-- `line_total_cents = qty x units_per_case x unit_price_cents`, with the factor
-- read from `products` at order time and frozen on the line. `unit_price_cents`
-- stays the PER-BASE-UNIT price the tarifa holds and the bridge sends to Wingest
-- as PREVEN — the portal shows a per-caja price, it does not store one.
--
-- The request hash is DELIBERATELY unchanged, and this is the one decision in
-- this file that a replay can notice. The hash covers what the CLIENT asked for —
-- products, quantities, delivery date, note — and `units_per_case` is none of
-- those: it is server data this function reads for itself, exactly like the
-- tarifa price it has always resolved rather than accepted. So a cart page
-- rendered before this deploy replays to the same hash and gets its EXISTING
-- order back (`duplicate: true`), which is what pressing submit twice has always
-- meant here. Versioning the hash would turn that same second press into
-- IDEMPOTENCY_MISMATCH — a refusal shown to a customer whose order did go through
-- — and would buy nothing: a replay returns the stored order untouched and
-- re-prices exactly nothing.
--
-- `create or replace` keeps the signature, so every grant on the function stands;
-- the revoke/grant block below restates it anyway, per the repo idiom.
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
  v_line_total integer;
  v_total integer := 0;
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
    -- `round` survives from v1 for the weighed future only: with integer cajas
    -- every operand is an integer and there is nothing to round.
    v_line_total := pg_catalog.round(v_qty * v_units * v_price)::integer;
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
