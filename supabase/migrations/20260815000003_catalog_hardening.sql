-- 0002b_catalog_hardening: close the gaps the 0002 apply surfaced.
-- Supabase default privileges grant EXECUTE per-role (anon/authenticated/service_role)
-- on every NEW function, so "revoke ... from public" alone never cuts anon - the same
-- bug class 0001b fixed for the RLS helpers. Revoke per role, explicitly.
alter function public.price_cents_for(public.products, smallint) set search_path = '';
revoke execute on function public.price_cents_for(public.products, smallint) from public, anon;
revoke execute on function public.set_updated_at() from public, anon, authenticated;
-- FK index the favorites screens will need once rows exist:
create index favorites_product on public.favorites(product_id);
