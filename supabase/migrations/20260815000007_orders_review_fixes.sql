-- 0003c_orders_review_fixes: pre-Plan-04 bridge-contract fixes from the Task 6 quality review.

-- (1) orders: albaran_at (symmetry with confirmed_at/injected_at), idempotency token,
--     cheap sanity CHECKs while the tables are empty.
alter table public.orders add column albaran_at timestamptz;
alter table public.orders add column client_token uuid;
create unique index orders_client_token on public.orders(company_id, client_token)
  where client_token is not null;
alter table public.orders
  add constraint orders_subtotal_nonneg check (subtotal_cents >= 0),
  add constraint orders_numped_pos check (numped is null or numped > 0),
  add constraint orders_numalb_pos check (numalb is null or numalb > 0);
alter table public.order_items
  add constraint order_items_price_nonneg check (unit_price_cents >= 0),
  add constraint order_items_line_nonneg check (line_total_cents >= 0);

-- (2) staff_note is internal. Same pattern as the price tiers in 0002c: not readable
--     by authenticated; staff tooling reads/writes it server-side via service role.
revoke select on public.orders from authenticated;
grant select (id, order_number, company_id, placed_by, status, delivery_date, customer_note,
  subtotal_cents, numped, numalb, client_token, created_at, confirmed_at, injected_at,
  albaran_at, updated_at) on public.orders to authenticated;

-- (3) create_order v2: company must be ERP-linked (codcli), delivery date sane,
--     empty note stored as NULL, line cap, optional idempotency token (double-tap /
--     retry-on-timeout returns the existing order instead of minting a twin).
--     Signature changes (new param) => drop + recreate + re-assert ACLs per-role.
drop function public.create_order(jsonb, date, text);
create function public.create_order(
  p_lines jsonb,
  p_delivery_date date default null,
  p_note text default null,
  p_client_token uuid default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_company uuid; v_tarcli smallint; v_codcli integer;
  v_order_id uuid; v_order_number integer;
  v_line jsonb; v_product products%rowtype;
  v_qty numeric(10,3); v_price integer; v_line_total integer;
  v_total integer := 0; v_n integer := 0;
begin
  select c.id, c.tarcli, c.codcli into v_company, v_tarcli, v_codcli
    from portal_users pu join companies c on c.id = pu.company_id
   where pu.id = auth.uid() and pu.is_active and c.is_active;
  if v_company is null then raise exception 'NO_ACTIVE_COMPANY'; end if;
  if v_codcli is null then raise exception 'COMPANY_NOT_LINKED'; end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'EMPTY_ORDER';
  end if;
  if jsonb_array_length(p_lines) > 200 then raise exception 'TOO_MANY_LINES'; end if;
  if p_delivery_date is not null
     and (p_delivery_date < current_date or p_delivery_date > current_date + 60) then
    raise exception 'BAD_DELIVERY_DATE';
  end if;

  if p_client_token is not null then
    select o.id, o.order_number into v_order_id, v_order_number
      from orders o where o.company_id = v_company and o.client_token = p_client_token;
    if found then
      return jsonb_build_object('order_id', v_order_id, 'order_number', v_order_number,
                                'duplicate', true);
    end if;
  end if;

  insert into orders (company_id, placed_by, delivery_date, customer_note, client_token)
  values (v_company, auth.uid(), p_delivery_date, nullif(p_note, ''), p_client_token)
  returning id, order_number into v_order_id, v_order_number;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_qty := (v_line->>'qty')::numeric(10,3);
    if v_qty is null or v_qty <= 0 then raise exception 'BAD_QTY'; end if;
    select * into v_product from products
     where id = (v_line->>'product_id')::uuid and is_orderable;
    if v_product.id is null then
      raise exception 'PRODUCT_UNAVAILABLE:%', v_line->>'product_id';
    end if;
    v_price := price_cents_for(v_product, v_tarcli);
    if v_price is null then
      raise exception 'NO_PRICE:%:tier %', v_product.codart, v_tarcli;
    end if;
    v_line_total := round(v_qty * v_price)::integer;
    v_n := v_n + 1;
    insert into order_items (order_id, product_id, codart, name, qty, unit,
                             unit_price_cents, line_total_cents, is_weighed, is_erp_excluded, sort_order)
    values (v_order_id, v_product.id, v_product.codart, v_product.name, v_qty, v_product.unit,
            v_price, v_line_total, v_product.is_weighed, v_product.is_erp_excluded, v_n);
    v_total := v_total + v_line_total;
  end loop;

  update orders set subtotal_cents = v_total where id = v_order_id;
  insert into order_events (order_id, event, actor) values (v_order_id, 'submitted', auth.uid());
  return jsonb_build_object('order_id', v_order_id, 'order_number', v_order_number);
exception
  when unique_violation then
    -- client_token race: a concurrent twin won; return the winner.
    if p_client_token is not null then
      select o.id, o.order_number into v_order_id, v_order_number
        from orders o where o.company_id = v_company and o.client_token = p_client_token;
      if v_order_id is not null then
        return jsonb_build_object('order_id', v_order_id, 'order_number', v_order_number,
                                  'duplicate', true);
      end if;
    end if;
    raise;
end $$;
revoke all on function public.create_order(jsonb, date, text, uuid) from public;
revoke all on function public.create_order(jsonb, date, text, uuid) from anon;
grant execute on function public.create_order(jsonb, date, text, uuid) to authenticated, service_role;

-- (4) bridge_fetch_confirmed v2: deterministic FIFO (coalesce(confirmed_at, created_at)
--     + order_number tiebreak, aggregated WITH order by), ERP-linked companies only,
--     staff_note removed from the payload (internal), items never null, line totals
--     included so the bridge can reconcile portal money vs Wingest money.
--     CREATE OR REPLACE keeps the existing service_role-only ACL.
create or replace function public.bridge_fetch_confirmed() returns jsonb
language sql security definer set search_path = public as $$
  select coalesce(jsonb_agg(o.payload order by o.sort_ts, o.order_number), '[]'::jsonb)
  from (
    select ord.order_number, coalesce(ord.confirmed_at, ord.created_at) as sort_ts,
           jsonb_build_object(
             'id', ord.id, 'order_number', ord.order_number,
             'delivery_date', ord.delivery_date, 'customer_note', ord.customer_note,
             'subtotal_cents', ord.subtotal_cents,
             'codcli', c.codcli, 'tarcli', c.tarcli, 'company_name', c.name,
             'items', coalesce((select jsonb_agg(jsonb_build_object(
                        'codart', i.codart, 'qty', i.qty,
                        'unit_price_cents', i.unit_price_cents,
                        'line_total_cents', i.line_total_cents,
                        'is_weighed', i.is_weighed, 'is_erp_excluded', i.is_erp_excluded)
                      order by i.sort_order)
                from order_items i where i.order_id = ord.id), '[]'::jsonb)
           ) as payload
      from orders ord join companies c on c.id = ord.company_id
     where ord.status = 'confirmed' and c.codcli is not null
  ) o
$$;

-- (5) bridge_mark_* v2: report the outcome (true = transition happened) and write the
--     audit event ONLY when it did. A false return means "order was not in the expected
--     state" - the bridge must log-and-alert, not assume success. Return type changes
--     => drop + recreate + re-assert ACLs per-role.
drop function public.bridge_mark_injected(uuid, integer);
create function public.bridge_mark_injected(p_order_id uuid, p_numped integer) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  update public.orders set status = 'injected', numped = p_numped, injected_at = now()
   where id = p_order_id and status = 'confirmed';
  if not found then return false; end if;
  insert into public.order_events (order_id, event, detail)
  values (p_order_id, 'injected', jsonb_build_object('numped', p_numped));
  return true;
end $$;
drop function public.bridge_mark_albaran(uuid, integer);
create function public.bridge_mark_albaran(p_order_id uuid, p_numalb integer) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  update public.orders set status = 'albaran', numalb = p_numalb, albaran_at = now()
   where id = p_order_id and status = 'injected';
  if not found then return false; end if;
  insert into public.order_events (order_id, event, detail)
  values (p_order_id, 'albaran', jsonb_build_object('numalb', p_numalb));
  return true;
end $$;
revoke all on function public.bridge_mark_injected(uuid, integer) from public;
revoke all on function public.bridge_mark_injected(uuid, integer) from anon;
revoke all on function public.bridge_mark_injected(uuid, integer) from authenticated;
grant execute on function public.bridge_mark_injected(uuid, integer) to service_role;
revoke all on function public.bridge_mark_albaran(uuid, integer) from public;
revoke all on function public.bridge_mark_albaran(uuid, integer) from anon;
revoke all on function public.bridge_mark_albaran(uuid, integer) from authenticated;
grant execute on function public.bridge_mark_albaran(uuid, integer) to service_role;

-- (6) normalize the order-number sequence burned by review probes (tables are empty).
select setval('public.order_number_seq', 1001, false);
