-- Forward-only security, order integrity, and bridge reliability fixes.
-- Existing public tables were verified empty before this migration was authored.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create or replace function private.is_staff()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.staff_users as staff
    where staff.id = (select auth.uid())
      and staff.is_active
  )
$$;

create or replace function private.my_company_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select portal.company_id
  from public.portal_users as portal
  where portal.id = (select auth.uid())
    and portal.is_active
$$;

create or replace function private.enforce_exclusive_user_role()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(new.id::text, 0)
  );

  if tg_table_name = 'portal_users' then
    if exists (select 1 from public.staff_users where id = new.id) then
      raise exception 'USER_ROLE_CONFLICT'
        using errcode = '23505', constraint = 'auth_user_role_exclusive';
    end if;
  elsif exists (select 1 from public.portal_users where id = new.id) then
    raise exception 'USER_ROLE_CONFLICT'
      using errcode = '23505', constraint = 'auth_user_role_exclusive';
  end if;

  return new;
end
$$;

revoke execute on all functions in schema private
  from public, anon, authenticated, service_role;

drop trigger if exists portal_users_exclusive_role on public.portal_users;
create trigger portal_users_exclusive_role
before insert or update of id on public.portal_users
for each row execute function private.enforce_exclusive_user_role();

drop trigger if exists staff_users_exclusive_role on public.staff_users;
create trigger staff_users_exclusive_role
before insert or update of id on public.staff_users
for each row execute function private.enforce_exclusive_user_role();

alter table public.orders
  drop constraint orders_placed_by_fkey,
  add constraint orders_placed_by_fkey
    foreign key (placed_by) references public.portal_users(id) on delete set null;

alter table public.order_items
  drop constraint order_items_product_id_fkey,
  add constraint order_items_product_id_fkey
    foreign key (product_id) references public.products(id) on delete set null;

alter table public.orders
  add column request_hash text,
  add column bridge_claim_token uuid,
  add column bridge_claimed_at timestamptz;

alter table public.orders drop constraint orders_status_check;
alter table public.orders
  add constraint orders_status_check
    check (status in (
      'submitted', 'confirmed', 'processing', 'injected', 'albaran', 'cancelled'
    )),
  add constraint orders_request_hash_shape
    check (request_hash is null or request_hash ~ '^[0-9a-f]{32}$'),
  add constraint orders_state_consistency check (
    ((status in ('confirmed', 'processing', 'injected', 'albaran'))
      = (confirmed_at is not null))
    and ((status = 'processing')
      = (bridge_claim_token is not null and bridge_claimed_at is not null))
    and ((status in ('injected', 'albaran'))
      = (numped is not null and injected_at is not null))
    and ((status = 'albaran')
      = (numalb is not null and albaran_at is not null))
  );

drop index public.orders_open;
create index orders_open on public.orders(status)
  where status in ('submitted', 'confirmed', 'processing');
create index orders_bridge_claim
  on public.orders(bridge_claimed_at, confirmed_at, order_number)
  where status in ('confirmed', 'processing');

drop policy companies_select on public.companies;
create policy companies_select on public.companies
for select to authenticated
using (
  (select private.is_staff())
  or id = (select private.my_company_id())
);
drop policy companies_staff_write on public.companies;
create policy companies_staff_insert on public.companies
for insert to authenticated with check ((select private.is_staff()));
create policy companies_staff_update on public.companies
for update to authenticated
using ((select private.is_staff()))
with check ((select private.is_staff()));
create policy companies_staff_delete on public.companies
for delete to authenticated using ((select private.is_staff()));

drop policy portal_users_select on public.portal_users;
create policy portal_users_select on public.portal_users
for select to authenticated
using (
  id = (select auth.uid())
  or (select private.is_staff())
);
drop policy portal_users_staff_write on public.portal_users;
create policy portal_users_staff_insert on public.portal_users
for insert to authenticated with check ((select private.is_staff()));
create policy portal_users_staff_update on public.portal_users
for update to authenticated
using ((select private.is_staff()))
with check ((select private.is_staff()));
create policy portal_users_staff_delete on public.portal_users
for delete to authenticated using ((select private.is_staff()));

drop policy categories_read on public.categories;
create policy categories_read on public.categories
for select to authenticated
using (
  (select private.is_staff())
  or (is_active and (select private.my_company_id()) is not null)
);
drop policy categories_staff_write on public.categories;
create policy categories_staff_insert on public.categories
for insert to authenticated with check ((select private.is_staff()));
create policy categories_staff_update on public.categories
for update to authenticated
using ((select private.is_staff()))
with check ((select private.is_staff()));
create policy categories_staff_delete on public.categories
for delete to authenticated using ((select private.is_staff()));

drop policy products_read on public.products;
create policy products_read on public.products
for select to authenticated
using (
  (select private.is_staff())
  or (select private.my_company_id()) is not null
);
drop policy products_staff_write on public.products;
create policy products_staff_insert on public.products
for insert to authenticated with check ((select private.is_staff()));
create policy products_staff_update on public.products
for update to authenticated
using ((select private.is_staff()))
with check ((select private.is_staff()));
create policy products_staff_delete on public.products
for delete to authenticated using ((select private.is_staff()));

drop policy favorites_rw on public.favorites;
create policy favorites_rw on public.favorites
for all to authenticated
using (company_id = (select private.my_company_id()))
with check (company_id = (select private.my_company_id()));

drop policy orders_read on public.orders;
create policy orders_read on public.orders
for select to authenticated
using (
  (select private.is_staff())
  or company_id = (select private.my_company_id())
);
drop policy orders_staff_update on public.orders;

drop policy order_items_read on public.order_items;
create policy order_items_read on public.order_items
for select to authenticated
using (
  exists (
    select 1
    from public.orders as parent
    where parent.id = order_id
      and (
        (select private.is_staff())
        or parent.company_id = (select private.my_company_id())
      )
  )
);

drop policy order_events_staff_read on public.order_events;
create policy order_events_staff_read on public.order_events
for select to authenticated
using ((select private.is_staff()));

drop view public.products_priced;
create view public.products_priced as
select
  product.id, product.codart, product.base_sku, product.variant_suffix,
  product.name, product.category_id, product.unit, product.units_per_case,
  product.is_weighed, product.is_erp_excluded, product.is_available,
  product.is_current_variant, product.is_orderable, product.iva_rate,
  product.image_url, product.sort_order,
  public.price_cents_for(product, company.tarcli) as price_cents
from public.products as product
join public.companies as company
  on company.id = private.my_company_id();

drop function public.create_order(jsonb, date, text, uuid);
create function public.create_order(
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

    v_line_total := pg_catalog.round(v_qty * v_price)::integer;
    v_n := v_n + 1;
    insert into public.order_items (
      order_id, product_id, codart, name, qty, unit, unit_price_cents,
      line_total_cents, is_weighed, is_erp_excluded, sort_order
    )
    values (
      v_order_id, v_product.id, v_product.codart, v_product.name,
      v_qty::numeric(10,3), v_product.unit, v_price, v_line_total,
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

create function public.staff_confirm_order(
  p_order_id uuid,
  p_staff_note text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_note text := nullif(pg_catalog.btrim(p_staff_note), '');
begin
  if not private.is_staff() then
    raise exception 'STAFF_ONLY' using errcode = '42501';
  end if;
  if v_note is not null and pg_catalog.length(v_note) > 2000 then
    raise exception 'NOTE_TOO_LONG';
  end if;

  update public.orders
  set status = 'confirmed', confirmed_at = pg_catalog.now(), staff_note = v_note
  where id = p_order_id and status = 'submitted';

  if not found then return false; end if;
  insert into public.order_events (order_id, event, actor)
  values (p_order_id, 'confirmed', (select auth.uid()));
  return true;
end
$$;

create function public.staff_cancel_order(
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
begin
  if not private.is_staff() then
    raise exception 'STAFF_ONLY' using errcode = '42501';
  end if;
  if v_reason is not null and pg_catalog.length(v_reason) > 2000 then
    raise exception 'NOTE_TOO_LONG';
  end if;

  update public.orders
  set status = 'cancelled', staff_note = v_reason
  where id = p_order_id and status = 'submitted';

  if not found then return false; end if;
  insert into public.order_events (order_id, event, detail, actor)
  values (
    p_order_id,
    'cancelled',
    case when v_reason is null then null
      else pg_catalog.jsonb_build_object('reason', v_reason) end,
    (select auth.uid())
  );
  return true;
end
$$;

drop function public.bridge_fetch_confirmed();
create function public.bridge_claim_confirmed(
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
  select pg_catalog.coalesce(
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
        'items', pg_catalog.coalesce(
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

drop function public.bridge_mark_injected(uuid, integer);
create function public.bridge_mark_injected(
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
    bridge_claimed_at = null
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

create or replace function public.bridge_mark_albaran(
  p_order_id uuid,
  p_numalb integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_numalb is null or p_numalb <= 0 then return false; end if;

  update public.orders
  set status = 'albaran', numalb = p_numalb, albaran_at = pg_catalog.now()
  where id = p_order_id and status = 'injected';

  if not found then return false; end if;
  insert into public.order_events (order_id, event, detail)
  values (
    p_order_id,
    'albaran',
    pg_catalog.jsonb_build_object('numalb', p_numalb)
  );
  return true;
end
$$;

drop function public.is_staff();
drop function public.my_company_id();

revoke all privileges on
  public.companies,
  public.portal_users,
  public.staff_users,
  public.categories,
  public.products,
  public.favorites,
  public.orders,
  public.order_items,
  public.order_events,
  public.products_priced
from public, anon, authenticated;

grant select (
  id, codcli, name, cif, tarcli, phone, address, postal_code,
  is_active, created_at, updated_at
) on public.companies to authenticated;
grant insert, update, delete on public.companies to authenticated;

grant select, insert, update, delete
  on public.portal_users to authenticated;
grant select on public.staff_users to authenticated;
grant select, insert, update, delete
  on public.categories to authenticated;

grant select (
  id, codart, base_sku, variant_suffix, is_current_variant, name, category_id,
  unit, units_per_case, is_weighed, is_available, is_erp_excluded, is_orderable,
  iva_rate, image_url, sort_order, erp_synced_at, created_at, updated_at
) on public.products to authenticated;
grant insert (
  codart, base_sku, variant_suffix, is_current_variant, name, category_id,
  unit, units_per_case, is_weighed, is_available, is_erp_excluded,
  iva_rate, image_url, sort_order, erp_synced_at
) on public.products to authenticated;
grant update (
  codart, base_sku, variant_suffix, is_current_variant, name, category_id,
  unit, units_per_case, is_weighed, is_available, is_erp_excluded,
  iva_rate, image_url, sort_order, erp_synced_at
) on public.products to authenticated;
grant delete on public.products to authenticated;

grant select, insert, update, delete on public.favorites to authenticated;

grant select (
  id, order_number, company_id, placed_by, status, delivery_date,
  customer_note, subtotal_cents, numped, numalb, created_at, confirmed_at,
  injected_at, albaran_at, updated_at
) on public.orders to authenticated;
grant select on public.order_items, public.order_events to authenticated;
grant select on public.products_priced to authenticated;

revoke all privileges on all sequences in schema public
  from public, anon, authenticated;
grant usage on sequence public.categories_id_seq to authenticated;

grant all privileges on
  public.companies,
  public.portal_users,
  public.staff_users,
  public.categories,
  public.products,
  public.favorites,
  public.orders,
  public.order_items,
  public.order_events,
  public.products_priced
to service_role;
grant all privileges on all sequences in schema public to service_role;

revoke all on function public.set_updated_at()
  from public, anon, authenticated;
revoke all on function public.price_cents_for(public.products, smallint)
  from public, anon, authenticated;
revoke all on function public.create_order(jsonb, date, text, uuid)
  from public, anon, authenticated;
revoke all on function public.staff_confirm_order(uuid, text)
  from public, anon, authenticated;
revoke all on function public.staff_cancel_order(uuid, text)
  from public, anon, authenticated;
revoke all on function public.bridge_claim_confirmed(uuid, integer, integer)
  from public, anon, authenticated, service_role;
revoke all on function public.bridge_mark_injected(uuid, uuid, integer)
  from public, anon, authenticated, service_role;
revoke all on function public.bridge_mark_albaran(uuid, integer)
  from public, anon, authenticated, service_role;

grant execute on function public.create_order(jsonb, date, text, uuid)
  to authenticated, service_role;
grant execute on function public.staff_confirm_order(uuid, text)
  to authenticated, service_role;
grant execute on function public.staff_cancel_order(uuid, text)
  to authenticated, service_role;
grant execute on function public.price_cents_for(public.products, smallint)
  to service_role;
grant execute on function public.bridge_claim_confirmed(uuid, integer, integer)
  to service_role;
grant execute on function public.bridge_mark_injected(uuid, uuid, integer)
  to service_role;
grant execute on function public.bridge_mark_albaran(uuid, integer)
  to service_role;

alter default privileges for role postgres in schema public
  revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke execute on functions from public, anon, authenticated;
alter default privileges for role postgres in schema public
  grant all on tables to service_role;
alter default privileges for role postgres in schema public
  grant all on sequences to service_role;
alter default privileges for role postgres in schema public
  grant execute on functions to service_role;
