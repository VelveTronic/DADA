-- 0001_core: companies (restaurant customers), portal_users, staff_users, RLS helpers
create or replace function public.set_updated_at() returns trigger
language plpgsql as $$ begin new.updated_at = now(); return new; end $$;

create table public.companies (
  id uuid primary key default gen_random_uuid(),
  codcli integer unique,                -- Wingest clientes.CODCLI (nullable during onboarding; required before bridge go-live)
  name text not null,
  cif text,
  tarcli smallint not null default 1 check (tarcli between 1 and 6),
  phone text,
  address text,
  postal_code text,
  is_active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger companies_updated_at before update on public.companies
  for each row execute function public.set_updated_at();

create table public.portal_users (
  id uuid primary key references auth.users(id) on delete cascade,
  company_id uuid not null references public.companies(id),
  display_name text,
  locale text not null default 'zh' check (locale in ('zh','es')),
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.staff_users (
  id uuid primary key references auth.users(id) on delete cascade,
  role text not null default 'staff' check (role in ('staff','manager','owner')),
  display_name text,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

-- SECURITY DEFINER helpers so RLS policies can consult these tables without recursion
create or replace function public.is_staff() returns boolean
language sql stable security definer set search_path = public as
$$ select exists (select 1 from public.staff_users s where s.id = auth.uid() and s.is_active) $$;

create or replace function public.my_company_id() returns uuid
language sql stable security definer set search_path = public as
$$ select p.company_id from public.portal_users p where p.id = auth.uid() and p.is_active $$;

revoke execute on function public.is_staff() from anon;
revoke execute on function public.my_company_id() from anon;

alter table public.companies enable row level security;
alter table public.portal_users enable row level security;
alter table public.staff_users enable row level security;

create policy companies_select on public.companies for select to authenticated
  using (public.is_staff() or id = public.my_company_id());
create policy companies_staff_write on public.companies for all to authenticated
  using (public.is_staff()) with check (public.is_staff());

create policy portal_users_select on public.portal_users for select to authenticated
  using (id = auth.uid() or public.is_staff());
create policy portal_users_staff_write on public.portal_users for all to authenticated
  using (public.is_staff()) with check (public.is_staff());

create policy staff_users_self_select on public.staff_users for select to authenticated
  using (id = auth.uid());
