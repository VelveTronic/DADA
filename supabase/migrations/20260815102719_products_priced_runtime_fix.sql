-- Keep the six-tier matrix behind the definer view while avoiding a helper-function
-- EXECUTE requirement for authenticated callers.
create or replace view public.products_priced as
select
  product.id, product.codart, product.base_sku, product.variant_suffix,
  product.name, product.category_id, product.unit, product.units_per_case,
  product.is_weighed, product.is_erp_excluded, product.is_available,
  product.is_current_variant, product.is_orderable, product.iva_rate,
  product.image_url, product.sort_order,
  case company.tarcli
    when 1 then product.price_1_cents
    when 2 then product.price_2_cents
    when 3 then product.price_3_cents
    when 4 then product.price_4_cents
    when 5 then product.price_5_cents
    when 6 then product.price_6_cents
  end as price_cents
from public.products as product
join public.companies as company
  on company.id = private.my_company_id();

revoke all on public.products_priced from public, anon;
