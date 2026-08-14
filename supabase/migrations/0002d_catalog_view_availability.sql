-- 0002d_catalog_view_availability: quality-review round 4 (final catalog polish).
-- (1) Unavailable products must be visible through the customer view too (grey-out UX;
--     favorites and repeat-last-order must always resolve). Ordering still gates on
--     is_orderable inside create_order. Expose is_available/is_current_variant so the
--     UI can distinguish "out of stock" from "superseded variant".
--     DROP + CREATE (not replace) so the column order stays clean; the full ACL is
--     re-asserted below because a fresh view re-acquires default grants.
-- NOTE: this view intentionally bypasses products RLS (owner postgres, no
--       security_invoker). If products_read ever tightens beyond using(true),
--       revisit this view in the same change.
drop view public.products_priced;
create view public.products_priced as
select p.id, p.codart, p.base_sku, p.variant_suffix, p.name, p.category_id, p.unit,
       p.units_per_case, p.is_weighed, p.is_erp_excluded, p.is_available,
       p.is_current_variant, p.is_orderable, p.iva_rate, p.image_url, p.sort_order,
       public.price_cents_for(p, c.tarcli) as price_cents
  from public.products p
  join public.companies c on c.id = public.my_company_id();
-- (2) Same migration ON PURPOSE (review NEW-1 + deferred ACL): a future edit that made
--     the view auto-updatable would turn stale default DML grants + postgres ownership
--     into a customer write path onto products. Scope to SELECT-only now.
revoke all on public.products_priced from public, anon, authenticated;
grant select on public.products_priced to authenticated;
-- (3) The natural key must be mandatory to do its job (importer may not create
--     unkeyed categories). Table is still empty, so this is free.
alter table public.categories alter column erp_code set not null;
-- (4) Deliberate: the view does NOT filter on companies.is_active - a deactivated
--     company keeps browsing prices; ordering is blocked in create_order.
