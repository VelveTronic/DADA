-- Category artwork and one atomic, server-validated write path for the complete
-- customer-facing category order.

alter table public.categories
  add column image_url text;

-- Category metadata remains staff-editable through the existing RLS policy,
-- but sort_order is no longer a column an authenticated Data API caller can
-- patch one row at a time. Reordering is the all-or-nothing RPC below.
revoke update on public.categories from authenticated;
grant update (
  name,
  parent_label,
  visibility,
  is_active,
  image_url
) on public.categories to authenticated;

create function public.staff_reorder_categories(
  p_order bigint[],
  p_locale text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_input_count integer;
  v_distinct_count integer;
  v_database_count integer;
begin
  if not private.is_staff() then
    raise exception 'STAFF_ONLY' using errcode = '42501';
  end if;

  if p_locale is null or p_locale not in ('zh', 'es') then
    raise exception 'BAD_LOCALE' using errcode = '22023';
  end if;

  if p_order is null
     or coalesce(pg_catalog.array_ndims(p_order), 0) <> 1
     or pg_catalog.cardinality(p_order) = 0 then
    raise exception 'BAD_ORDER' using errcode = '22023';
  end if;

  -- Stabilise the full set while it is checked and rewritten. This blocks a
  -- concurrent category insert/update/delete for the short duration of the RPC
  -- and prevents a phantom row from appearing between validation and UPDATE.
  lock table public.categories in share row exclusive mode;

  select
    pg_catalog.count(*)::integer,
    pg_catalog.count(distinct item.id)::integer
  into v_input_count, v_distinct_count
  from pg_catalog.unnest(p_order) as item(id);

  if v_input_count <> v_distinct_count
     or exists (
       select 1
       from pg_catalog.unnest(p_order) as item(id)
       where item.id is null
     ) then
    raise exception 'BAD_ORDER' using errcode = '22023';
  end if;

  select pg_catalog.count(*)::integer
  into v_database_count
  from public.categories;

  if v_input_count <> v_database_count
     or exists (
       select 1
       from pg_catalog.unnest(p_order) as item(id)
       left join public.categories as category on category.id = item.id
       where category.id is null
     ) then
    raise exception 'BAD_ORDER' using errcode = '22023';
  end if;

  -- `groupCategories()` groups by the visible parent label in the active
  -- locale, falling back to the other language. A real group has at least two
  -- children. Every such group's ids must occupy one contiguous interval in
  -- the submitted flattened order; otherwise a crafted client has interleaved
  -- children across parent groups, something the UI never permits.
  if exists (
    with desired as (
      select
        category.id,
        item.ordinality,
        case p_locale
          when 'zh' then coalesce(
            category.parent_label ->> 'zh',
            category.parent_label ->> 'es',
            ''
          )
          else coalesce(
            category.parent_label ->> 'es',
            category.parent_label ->> 'zh',
            ''
          )
        end as parent_name
      from pg_catalog.unnest(p_order) with ordinality as item(id, ordinality)
      join public.categories as category on category.id = item.id
    ), grouped as (
      select
        desired.parent_name,
        pg_catalog.count(*) as member_count,
        pg_catalog.min(desired.ordinality) as first_position,
        pg_catalog.max(desired.ordinality) as last_position
      from desired
      where desired.parent_name <> ''
      group by desired.parent_name
      having pg_catalog.count(*) > 1
    )
    select 1
    from grouped
    where grouped.last_position - grouped.first_position + 1
      <> grouped.member_count
  ) then
    raise exception 'BAD_TREE' using errcode = '22023';
  end if;

  update public.categories as category
  set sort_order = (item.ordinality * 10)::integer
  from pg_catalog.unnest(p_order) with ordinality as item(id, ordinality)
  where category.id = item.id;

  return true;
end
$$;

revoke execute on function public.staff_reorder_categories(bigint[], text)
  from public, anon;
grant execute on function public.staff_reorder_categories(bigint[], text)
  to authenticated, service_role;
