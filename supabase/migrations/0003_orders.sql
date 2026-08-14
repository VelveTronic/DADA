-- 0003_orders: orders/items/events, create_order RPC, bridge_* RPCs (service_role only)
create sequence public.order_number_seq start 1001;

create table public.orders (
  id uuid primary key default gen_random_uuid(),
  order_number integer not null unique default nextval('public.order_number_seq'),
  company_id uuid not null references public.companies(id),
  placed_by uuid references public.portal_users(id),
  status text not null default 'submitted'
    check (status in ('submitted','confirmed','injected','albaran','cancelled')),
  delivery_date date,
  customer_note text,
  staff_note text,
  subtotal_cents integer not null default 0,
  numped integer,                                -- Wingest pedido number (bridge writes)
  numalb integer,                                -- Wingest albarán number (bridge writes)
  created_at timestamptz not null default now(),
  confirmed_at timestamptz,
  injected_at timestamptz,
  updated_at timestamptz not null default now()
);
create trigger orders_updated_at before update on public.orders
  for each row execute function public.set_updated_at();
create index orders_company on public.orders(company_id, created_at desc);
create index orders_open on public.orders(status) where status in ('submitted','confirmed');

create table public.order_items (
  id bigint generated always as identity primary key,
  order_id uuid not null references public.orders(id) on delete cascade,
  product_id uuid references public.products(id),
  codart text not null,
  name jsonb not null,
  qty numeric(10,3) not null check (qty > 0),
  unit text not null,
  unit_price_cents integer not null,
  line_total_cents integer not null,
  is_weighed boolean not null default false,
  is_erp_excluded boolean not null default false,
  sort_order integer not null default 0
);
create index order_items_order on public.order_items(order_id);

create table public.order_events (
  id bigint generated always as identity primary key,
  order_id uuid not null references public.orders(id) on delete cascade,
  event text not null,
  detail jsonb,
  actor uuid,
  created_at timestamptz not null default now()
);
create index order_events_order on public.order_events(order_id);

alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.order_events enable row level security;

create policy orders_read on public.orders for select to authenticated
  using ((select public.is_staff()) or company_id = (select public.my_company_id()));
create policy orders_staff_update on public.orders for update to authenticated
  using ((select public.is_staff())) with check ((select public.is_staff()));
create policy order_items_read on public.order_items for select to authenticated
  using (exists (select 1 from public.orders o
                  where o.id = order_id
                    and ((select public.is_staff()) or o.company_id = (select public.my_company_id()))));
create policy order_events_staff_read on public.order_events for select to authenticated
  using ((select public.is_staff()));
-- NO insert policies on purpose: all writes go through the RPCs below.
revoke all on public.orders, public.order_items, public.order_events from anon;
revoke insert, delete, truncate, references, trigger on public.orders from authenticated;
revoke insert, update, delete, truncate, references, trigger on public.order_items, public.order_events from authenticated;
-- (products_priced view ACL was scoped to SELECT-only in 0002d; nothing to do here.)

create or replace function public.create_order(
  p_lines jsonb,                       -- [{"product_id": "...uuid...", "qty": 2.5}, ...]
  p_delivery_date date default null,
  p_note text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_company uuid; v_tarcli smallint;
  v_order_id uuid; v_order_number integer;
  v_line jsonb; v_product products%rowtype;
  v_qty numeric(10,3); v_price integer; v_line_total integer;
  v_total integer := 0; v_n integer := 0;
begin
  select c.id, c.tarcli into v_company, v_tarcli
    from portal_users pu join companies c on c.id = pu.company_id
   where pu.id = auth.uid() and pu.is_active and c.is_active;
  if v_company is null then raise exception 'NO_ACTIVE_COMPANY'; end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'EMPTY_ORDER';
  end if;

  insert into orders (company_id, placed_by, delivery_date, customer_note)
  values (v_company, auth.uid(), p_delivery_date, p_note)
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
end $$;

revoke all on function public.create_order(jsonb, date, text) from public;
revoke all on function public.create_order(jsonb, date, text) from anon;
grant execute on function public.create_order(jsonb, date, text) to authenticated;

-- ============ bridge surface (service_role ONLY — the on-prem Wingest agent) ============
create or replace function public.bridge_fetch_confirmed() returns jsonb
language sql security definer set search_path = public as $$
  select coalesce(jsonb_agg(o), '[]'::jsonb) from (
    select ord.id, ord.order_number, ord.delivery_date, ord.customer_note, ord.staff_note,
           ord.subtotal_cents, c.codcli, c.tarcli, c.name as company_name,
           (select jsonb_agg(jsonb_build_object(
                     'codart', i.codart, 'qty', i.qty,
                     'unit_price_cents', i.unit_price_cents,
                     'is_weighed', i.is_weighed, 'is_erp_excluded', i.is_erp_excluded)
                   order by i.sort_order)
              from order_items i where i.order_id = ord.id) as items
      from orders ord join companies c on c.id = ord.company_id
     where ord.status = 'confirmed'
     order by ord.confirmed_at
  ) o
$$;

create or replace function public.bridge_mark_injected(p_order_id uuid, p_numped integer) returns void
language sql security definer set search_path = public as $$
  update orders set status = 'injected', numped = p_numped, injected_at = now()
   where id = p_order_id and status = 'confirmed';
  insert into order_events (order_id, event, detail)
  values (p_order_id, 'injected', jsonb_build_object('numped', p_numped));
$$;

create or replace function public.bridge_mark_albaran(p_order_id uuid, p_numalb integer) returns void
language sql security definer set search_path = public as $$
  update orders set status = 'albaran', numalb = p_numalb
   where id = p_order_id and status = 'injected';
  insert into order_events (order_id, event, detail)
  values (p_order_id, 'albaran', jsonb_build_object('numalb', p_numalb));
$$;

revoke all on function public.bridge_fetch_confirmed() from public;
revoke all on function public.bridge_fetch_confirmed() from anon;
revoke all on function public.bridge_fetch_confirmed() from authenticated;
grant execute on function public.bridge_fetch_confirmed() to service_role;
revoke all on function public.bridge_mark_injected(uuid, integer) from public;
revoke all on function public.bridge_mark_injected(uuid, integer) from anon;
revoke all on function public.bridge_mark_injected(uuid, integer) from authenticated;
grant execute on function public.bridge_mark_injected(uuid, integer) to service_role;
revoke all on function public.bridge_mark_albaran(uuid, integer) from public;
revoke all on function public.bridge_mark_albaran(uuid, integer) from anon;
revoke all on function public.bridge_mark_albaran(uuid, integer) from authenticated;
grant execute on function public.bridge_mark_albaran(uuid, integer) to service_role;
