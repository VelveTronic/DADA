-- 0002_catalog: bilingual catalog with 6-tier prices (integer cents), variants, weighed flag
create table public.categories (
  id bigint generated always as identity primary key,
  name jsonb not null default '{}'::jsonb,      -- {"es": "...", "zh": "..."}
  sort_order integer not null default 0,
  is_active boolean not null default true
);

create table public.products (
  id uuid primary key default gen_random_uuid(),
  codart text not null unique,                  -- ERP SKU, e.g. '100-034A'
  base_sku text not null,                       -- '100-034'
  variant_suffix text not null default '',      -- 'A' | 'B' | ... | ''
  is_current_variant boolean not null default true,
  name jsonb not null,                          -- {"es": "...", "zh": "..."}
  category_id bigint references public.categories(id),
  unit text not null default 'UNIDAD',          -- UNIDAD | CAJA | KG
  units_per_case numeric(10,3),
  is_weighed boolean not null default false,
  is_available boolean not null default true,
  is_erp_excluded boolean not null default false, -- Wingest rejects it; needs separate handling
  iva_rate numeric(5,2) not null default 21.00,
  price_1_cents integer, price_2_cents integer, price_3_cents integer,
  price_4_cents integer, price_5_cents integer, price_6_cents integer,
  image_url text,
  erp_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger products_updated_at before update on public.products
  for each row execute function public.set_updated_at();

-- at most ONE sellable variant per base SKU
create unique index products_one_current_variant on public.products(base_sku) where is_current_variant;
create index products_base_sku on public.products(base_sku);
create index products_category on public.products(category_id);

create or replace function public.price_cents_for(p public.products, tier smallint) returns integer
language sql immutable as $$
  select case tier
    when 1 then p.price_1_cents when 2 then p.price_2_cents when 3 then p.price_3_cents
    when 4 then p.price_4_cents when 5 then p.price_5_cents when 6 then p.price_6_cents
  end
$$;

create table public.favorites (
  company_id uuid not null references public.companies(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (company_id, product_id)
);

alter table public.categories enable row level security;
alter table public.products enable row level security;
alter table public.favorites enable row level security;

-- login-gated catalog: authenticated only (no anon policies at all)
-- RLS predicates InitPlan-wrapped: helpers evaluate once per statement, not per row.
create policy categories_read on public.categories for select to authenticated using (true);
create policy categories_staff_write on public.categories for all to authenticated
  using ((select public.is_staff())) with check ((select public.is_staff()));

create policy products_read on public.products for select to authenticated
  using (is_available or (select public.is_staff()));
create policy products_staff_write on public.products for all to authenticated
  using ((select public.is_staff())) with check ((select public.is_staff()));

create policy favorites_rw on public.favorites for all to authenticated
  using (company_id = (select public.my_company_id()))
  with check (company_id = (select public.my_company_id()));

-- Grants hygiene (TOKACHI C1 pattern): anon gets nothing; authenticated writes only
-- where an RLS staff policy exists; favorites is customer-writable (RLS-gated).
revoke all on public.categories, public.products, public.favorites from anon;
revoke truncate, references, trigger on public.categories, public.products, public.favorites from authenticated;
