-- Make the Wingest pedido and albarán identities stable across fiscal years.
--
-- NUMPED is only unique inside a CAN/EJE namespace. Persisting the complete
-- tuple removes ambiguous cross-year matches while still letting recovery use
-- the original stored namespace. Albarán has its own CAN/EJE namespace because
-- a December Pedido may become an Albarán in the following fiscal year.
--
-- Historical rows are intentionally not assigned a guessed CAN/EJE here.
-- Bridge replay reads pedclica/pedclicah from Wingest and calls the restricted
-- backfill RPC below with the actual identity.

alter table public.orders
  add column erp_can text,
  add column erp_eje integer,
  add column albaran_can text,
  add column albaran_eje integer;

alter table public.orders
  drop constraint orders_state_consistency;

-- Self-healing repeat of the same statement in 20260817100000. Rows claimed
-- under the pre-hardening schema carry no attempt count, and the constraint
-- below requires a `processing` row to have consumed at least one; 1 is the
-- honest value because such a row was claimed at least once. A no-op on any
-- database that already ran the failure-recovery migration, which is what keeps
-- this migration's ADD CONSTRAINT self-contained.
update public.orders
set bridge_attempt_count = 1
where status = 'processing'
  and bridge_attempt_count = 0;

alter table public.orders
  add constraint orders_erp_can_shape check (
    erp_can is null
    or (
      erp_can = pg_catalog.btrim(erp_can)
      and erp_can = pg_catalog.upper(erp_can)
      and pg_catalog.length(erp_can) between 1 and 2
    )
  ),
  add constraint orders_erp_eje_range check (
    erp_eje is null or erp_eje between 1 and 9999
  ),
  add constraint orders_albaran_can_shape check (
    albaran_can is null
    or (
      albaran_can = pg_catalog.btrim(albaran_can)
      and albaran_can = pg_catalog.upper(albaran_can)
      and pg_catalog.length(albaran_can) between 1 and 2
    )
  ),
  add constraint orders_albaran_eje_range check (
    albaran_eje is null or albaran_eje between 1 and 9999
  ),
  -- Recreated verbatim from 20260817100000 apart from the three identity
  -- additions: the injected/albarán clause now also pins erp_can/erp_eje to
  -- that state, and the two namespace halves must be present or absent
  -- together. Every bridge-failure clause is unchanged.
  add constraint orders_state_consistency check (
    ((status in ('confirmed', 'processing', 'bridge_failed', 'injected', 'albaran'))
      = (confirmed_at is not null))
    and ((status = 'processing')
      = (bridge_claim_token is not null and bridge_claimed_at is not null))
    and ((bridge_claim_token is null) = (bridge_claimed_at is null))
    and (
      (
        status in ('injected', 'albaran')
        and numped is not null
        and injected_at is not null
      )
      or (
        status not in ('injected', 'albaran')
        and erp_can is null
        and erp_eje is null
        and numped is null
        and injected_at is null
      )
    )
    and ((erp_can is null) = (erp_eje is null))
    and ((albaran_can is null) = (albaran_eje is null))
    and ((status = 'albaran')
      = (numalb is not null and albaran_at is not null))
    and (
      status = 'processing'
      or ((bridge_attempt_count = 0) = (bridge_last_error_code is null))
    )
    and (status <> 'processing' or bridge_attempt_count between 1 and 5)
    and ((bridge_last_error_code is null) = (bridge_failed_at is null))
    and (bridge_last_error_message is null or bridge_last_error_code is not null)
    and (bridge_next_attempt_at is null or (
      status = 'confirmed' and bridge_attempt_count > 0
    ))
    and (status <> 'bridge_failed' or (
      bridge_attempt_count > 0
      and bridge_last_error_code is not null
      and bridge_failed_at is not null
      and bridge_next_attempt_at is null
    ))
    and (status not in ('submitted', 'cancelled', 'injected', 'albaran') or (
      bridge_attempt_count = 0
      and bridge_last_error_code is null
      and bridge_last_error_message is null
      and bridge_failed_at is null
      and bridge_next_attempt_at is null
    ))
  );

create unique index orders_erp_pedido_identity
  on public.orders(erp_can, erp_eje, numped)
  where numped is not null;

create function public.bridge_backfill_order_identity(
  p_order_id uuid,
  p_can text,
  p_eje integer,
  p_numped integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_can text := pg_catalog.upper(pg_catalog.btrim(p_can));
begin
  if p_order_id is null
     or v_can is null
     or pg_catalog.length(v_can) not between 1 and 2
     or p_eje is null
     or p_eje not between 1 and 9999
     or p_numped is null
     or p_numped <= 0 then
    return false;
  end if;

  update public.orders
  set
    erp_can = v_can,
    erp_eje = p_eje
  where id = p_order_id
    and status in ('injected', 'albaran')
    and numped = p_numped
    and injected_at is not null
    and erp_can is null
    and erp_eje is null;

  return found;
end
$$;

drop function public.bridge_mark_injected(uuid, uuid, integer);

create function public.bridge_mark_injected(
  p_order_id uuid,
  p_claim_token uuid,
  p_can text,
  p_eje integer,
  p_numped integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_can text := pg_catalog.upper(pg_catalog.btrim(p_can));
begin
  if p_claim_token is null
     or v_can is null
     or pg_catalog.length(v_can) not between 1 and 2
     or p_eje is null
     or p_eje not between 1 and 9999
     or p_numped is null
     or p_numped <= 0 then
    return false;
  end if;

  update public.orders
  set
    status = 'injected',
    erp_can = v_can,
    erp_eje = p_eje,
    numped = p_numped,
    injected_at = pg_catalog.now(),
    bridge_claim_token = null,
    bridge_claimed_at = null,
    bridge_attempt_count = 0,
    bridge_last_error_code = null,
    bridge_last_error_message = null,
    bridge_failed_at = null,
    bridge_next_attempt_at = null
  where id = p_order_id
    and status = 'processing'
    and bridge_claim_token = p_claim_token;

  if not found then return false; end if;

  insert into public.order_events (order_id, event, detail)
  values (
    p_order_id,
    'injected',
    pg_catalog.jsonb_build_object(
      'can', v_can,
      'eje', p_eje,
      'numped', p_numped
    )
  );

  return true;
end
$$;

drop function public.bridge_mark_albaran(uuid, integer);

create function public.bridge_mark_albaran(
  p_order_id uuid,
  p_can text,
  p_eje integer,
  p_numalb integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_can text := pg_catalog.upper(pg_catalog.btrim(p_can));
begin
  if p_order_id is null
     or v_can is null
     or pg_catalog.length(v_can) not between 1 and 2
     or p_eje is null
     or p_eje not between 1 and 9999
     or p_numalb is null
     or p_numalb <= 0 then
    return false;
  end if;

  update public.orders
  set
    status = 'albaran',
    albaran_can = v_can,
    albaran_eje = p_eje,
    numalb = p_numalb,
    albaran_at = pg_catalog.now()
  where id = p_order_id
    and status = 'injected'
    and numped is not null
    and injected_at is not null;

  if not found then return false; end if;

  insert into public.order_events (order_id, event, detail)
  values (
    p_order_id,
    'albaran',
    pg_catalog.jsonb_build_object(
      'can', v_can,
      'eje', p_eje,
      'numalb', p_numalb
    )
  );
  return true;
end
$$;

-- Customers and staff may read the namespace alongside the already-visible
-- NUMPED, subject to the existing orders RLS policy. Only the on-prem bridge
-- can attach an ERP identity.
revoke select (erp_can, erp_eje)
  on public.orders from public, anon;
grant select (erp_can, erp_eje)
  on public.orders to authenticated;
revoke select (albaran_can, albaran_eje)
  on public.orders from public, anon;
grant select (albaran_can, albaran_eje)
  on public.orders to authenticated;

revoke all on function public.bridge_backfill_order_identity(uuid, text, integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.bridge_backfill_order_identity(uuid, text, integer, integer)
  to service_role;
revoke all on function public.bridge_mark_injected(uuid, uuid, text, integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.bridge_mark_injected(uuid, uuid, text, integer, integer)
  to service_role;
revoke all on function public.bridge_mark_albaran(uuid, text, integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.bridge_mark_albaran(uuid, text, integer, integer)
  to service_role;
