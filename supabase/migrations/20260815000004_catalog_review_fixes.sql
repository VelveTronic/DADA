-- 0002c_catalog_review_fixes: Task 5 quality-review fixes, applied while tables are empty.
-- Theme: every "no error, wrong data" import trap becomes a loud constraint failure.

-- (1) Shape constraints on products.
alter table public.products
  add constraint products_codart_trimmed check (codart = btrim(codart) and codart <> ''),
  add constraint products_codart_composition check (codart = base_sku || variant_suffix),
  add constraint products_name_shape check (jsonb_typeof(name) = 'object' and (name ? 'zh' or name ? 'es')),
  add constraint products_iva_known check (iva_rate in (4, 10, 21)),
  add constraint products_units_per_case_pos check (units_per_case is null or units_per_case > 0),
  add constraint products_price_1_nonneg check (price_1_cents is null or price_1_cents >= 0),
  add constraint products_price_2_nonneg check (price_2_cents is null or price_2_cents >= 0),
  add constraint products_price_3_nonneg check (price_3_cents is null or price_3_cents >= 0),
  add constraint products_price_4_nonneg check (price_4_cents is null or price_4_cents >= 0),
  add constraint products_price_5_nonneg check (price_5_cents is null or price_5_cents >= 0),
  add constraint products_price_6_nonneg check (price_6_cents is null or price_6_cents >= 0);
alter table public.products add column sort_order integer not null default 0;
-- Orderable = available AND the current variant of its base SKU. is_erp_excluded items
-- stay orderable (they are split out for manual handling downstream).
alter table public.products add column is_orderable boolean
  generated always as (is_available and is_current_variant) stored;

-- NOTE for the importer: products_one_current_variant is a PARTIAL unique index and
-- can never be DEFERRABLE. When switching the current variant of a base_sku, demote
-- the whole group FIRST, then promote the new one - never in a single UPDATE.

-- (2) categories: natural key for the nightly sync, audit timestamps, name shape, active gating.
alter table public.categories
  add column erp_code text unique,
  add column created_at timestamptz not null default now(),
  add column updated_at timestamptz not null default now();
alter table public.categories alter column name drop default;
alter table public.categories add constraint categories_name_shape
  check (jsonb_typeof(name) = 'object' and (name ? 'zh' or name ? 'es'));
create trigger categories_updated_at before update on public.categories
  for each row execute function public.set_updated_at();
drop policy categories_read on public.categories;
create policy categories_read on public.categories for select to authenticated
  using (is_active or (select public.is_staff()));

-- (3) Unavailable products stay VISIBLE (UI greys them out) so favorites and
--     repeat-last-order can always resolve; ordering is gated in create_order.
drop policy products_read on public.products;
create policy products_read on public.products for select to authenticated using (true);

-- (4) CRITICAL: scope the price read surface. Authenticated must not read the 6-tier
--     matrix; customers get ONE computed price via products_priced; staff tooling
--     reads raw tiers server-side via service_role after the staff guard.
revoke select on public.products from authenticated;
grant select (id, codart, base_sku, variant_suffix, is_current_variant, name, category_id,
  unit, units_per_case, is_weighed, is_available, is_erp_excluded, is_orderable, iva_rate,
  image_url, sort_order, erp_synced_at, created_at, updated_at)
  on public.products to authenticated;
-- View owner is postgres (NOT security_invoker) on purpose: the column grants above
-- would block the price columns for the invoker, while my_company_id() still resolves
-- to the CALLER inside the view body, so each company sees only its own tarifa price.
create view public.products_priced as
select p.id, p.codart, p.base_sku, p.variant_suffix, p.name, p.category_id, p.unit,
       p.units_per_case, p.is_weighed, p.is_erp_excluded, p.is_orderable, p.iva_rate,
       p.image_url, p.sort_order,
       public.price_cents_for(p, c.tarcli) as price_cents
  from public.products p
  join public.companies c on c.id = public.my_company_id()
 where p.is_available;
revoke all on public.products_priced from public, anon;
grant select on public.products_priced to authenticated;
