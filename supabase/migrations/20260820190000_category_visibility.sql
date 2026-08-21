-- Per-customer category visibility (owner, 2026-08-20).
--
-- A category is either visible to every restaurant ('all', the default and the
-- state every existing row keeps) or only to the companies named in
-- `category_companies` ('selected') — the shape 泰餐店专用 / TAKOMAMA专用系列
-- always wanted. Enforcement is DISPLAY-level: the catalogue and search hide
-- the rail entry and the products of a category the caller may not see. It is
-- deliberately not a hard read boundary — `products_priced` RLS is unchanged,
-- and a customer crafting raw PostgREST reads can still resolve such a product
-- by id. The boundary that matters (prices, ordering, other companies' data)
-- is where it always was.
--
-- Hierarchy note: the 一级/二级 grouping that ships alongside this migration
-- needs NO schema — `categories.parent_label` (seeded 2026-08-15) is the
-- grouping key, and the app treats equal labels as one group.

alter table public.categories
  add column visibility text not null default 'all'
    constraint categories_visibility_check check (visibility in ('all', 'selected'));

create table public.category_companies (
  category_id bigint not null references public.categories(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (category_id, company_id)
);

-- The customer-side filter asks "which selected categories am I allowed?",
-- which scans by company.
create index category_companies_company on public.category_companies(company_id);

alter table public.category_companies enable row level security;

-- Staff manage the grants wholesale (the 分类管理 lane: session client under
-- RLS, zero new RPCs — the same shape A2 shipped for categories itself).
create policy category_companies_staff on public.category_companies
  for all to authenticated
  using ((select private.is_staff()))
  with check ((select private.is_staff()));

-- A restaurant reads ONLY its own grants: enough to know which 'selected'
-- categories include it, nothing about which other companies are on a list.
create policy category_companies_own_read on public.category_companies
  for select to authenticated
  using (company_id = (select private.my_company_id()));

-- Per-role grants, the repo idiom: revoke first, then exactly what the
-- policies above police. anon gets nothing.
revoke all on public.category_companies from anon;
revoke all on public.category_companies from authenticated;
grant select, insert, delete on public.category_companies to authenticated;
