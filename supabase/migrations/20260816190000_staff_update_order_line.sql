-- staff_update_order_line: the real weight, set before the order is confirmed.
--
-- The weighed-goods workflow the owner described (2026-08-12, restated
-- 2026-08-16): a restaurant orders 1 of 柠檬 F-003 as an ESTIMATE, the warehouse
-- puts it on the scale, and a staff member sets the real 5.2 kg in the
-- confirmation queue. Money follows the quantity, the order is confirmed, and the
-- bridge injects `CANSER = 5.2` — Wingest's own KILO convention, which is why
-- weighed articles carry `units_per_case = 1` and a per-KG `PREVEN`.
--
-- The same edit covers the OTHER thing a warehouse does to a pending order:
-- 3 cajas were ordered and 2 are in stock. Line removal is deliberately NOT part
-- of it — cancel the order instead — because a removed line has no obvious
-- meaning for a customer looking at their own /pedidos page, and `qty > 0` is a
-- column constraint besides.
--
-- WHAT THIS FUNCTION WILL NOT DO
-- 1. Touch `unit_price_cents` or `units_per_case`. Both are the SNAPSHOT the
--    order was priced with, read back below and multiplied, never re-resolved:
--    a price change between placing and confirming is not this feature, and a
--    re-read from `products` would silently re-price an order a restaurant has
--    already agreed to.
-- 2. Run after `confirmed`. The gate is `status = 'submitted'` and nothing else,
--    which is what keeps this out of the bridge's way: `bridge_claim_confirmed`
--    only ever claims `confirmed` rows, so there is no window in which an edit
--    lands on an order already leased to Wingest.
-- 3. Trust the caller for anything but the three values it is given. The line's
--    factor, its price and the product's weighed flag are all read here, at call
--    time, from `order_items` joined to `products`.
--
-- Money is multiplication of integer cents by integer factors, accumulated in
-- `bigint`, exactly as `create_order` v3 does it. The `integer` columns are the
-- last word on range, also as in v3: a line total that does not fit one is a line
-- that must fail, and it fails at the column after the guards below have had
-- their say — inside a transaction that then leaves the order untouched.
--
-- The return is `boolean`, and `false` means the order is no longer editable —
-- someone confirmed or cancelled it while this queue page was open. That is the
-- same contract `staff_confirm_order` and `staff_cancel_order` already have for
-- exactly this condition, and the queue already has a banner for it, so the
-- plan's `BAD_STATE` is expressed as their `false` rather than as a fourth way of
-- saying the same thing. Genuinely malformed input still raises.
create or replace function public.staff_update_order_line(
  p_order_id uuid,
  p_item_id bigint,
  p_qty numeric,
  p_note text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_note text := nullif(pg_catalog.btrim(p_note), '');
  v_status text;
  v_codart text;
  v_old_qty numeric;
  v_units integer;
  v_price integer;
  v_weighed boolean;
  v_line_total bigint;
  v_subtotal bigint;
  v_detail jsonb;
begin
  if not private.is_staff() then
    raise exception 'STAFF_ONLY' using errcode = '42501';
  end if;
  if v_note is not null and pg_catalog.length(v_note) > 2000 then
    raise exception 'NOTE_TOO_LONG';
  end if;

  -- The order row is LOCKED, not merely read. Two staff members editing two
  -- lines of the same order would otherwise both sum the lines as they found
  -- them and both write a subtotal, and the second write would be missing the
  -- first one's line. The lock makes the whole edit — gate, line, subtotal —
  -- one at a time per order. It cannot block on the bridge: `submitted` is a
  -- state `bridge_claim_confirmed` never looks at.
  select ord.status
  into v_status
  from public.orders as ord
  where ord.id = p_order_id
  for update;

  if not found or v_status <> 'submitted' then return false; end if;

  -- The line, and the two different kinds of truth it needs.
  --
  -- `units_per_case` and `unit_price_cents` come off the ITEM: they are what the
  -- customer was quoted, frozen at submit, and the bridge sends the same pair to
  -- Wingest. `is_weighed` comes off the PRODUCT, live, because it is not a term
  -- of the sale — it is the rule for what a quantity may look like, and the
  -- product admin's 称重 toggle has to reach the orders already waiting in the
  -- queue on the day the owner flags an article. The item's own snapshot is the
  -- fallback for the one case the join cannot answer: a product row deleted out
  -- from under a historic line (`product_id` is nullable for exactly that).
  select
    item.codart,
    item.qty,
    item.units_per_case,
    item.unit_price_cents,
    coalesce(product.is_weighed, item.is_weighed)
  into v_codart, v_old_qty, v_units, v_price, v_weighed
  from public.order_items as item
  left join public.products as product on product.id = item.product_id
  where item.id = p_item_id
    and item.order_id = p_order_id;

  -- Belongs to another order, or does not exist. Only a crafted call gets here.
  if not found then raise exception 'BAD_LINE'; end if;

  -- The quantity rules are `create_order`'s, verbatim, down to the error codes:
  -- the queue must not accept a line the cart would have refused, and a staff
  -- member who sees `BAD_QTY_STEP` on this page is reading the same sentence a
  -- customer would have. NaN is checked as text because `NaN <= 0` is false and
  -- `NaN = NaN` is false — the comparison operators cannot see it.
  if p_qty is null
     or p_qty::text = 'NaN'
     or p_qty <= 0
     or pg_catalog.scale(p_qty) > 3 then
    raise exception 'BAD_QTY';
  end if;
  if not v_weighed and p_qty <> pg_catalog.trunc(p_qty) then
    raise exception 'BAD_QTY_STEP:%', v_codart;
  end if;
  -- The same roof `create_order` v3 puts on the BASE units, for the same reason:
  -- it is what the bridge will send as CANPED/CANSER, and it stops an absurd
  -- quantity from becoming a raw numeric error instead of a named one.
  if p_qty * v_units > 1000000 then
    raise exception 'BAD_QTY';
  end if;

  -- `round` matters here in a way it never did in `create_order`: this is the
  -- multiplication that actually has a fraction in it. 5.2 kg x factor 1 x 139
  -- cents = 722.8, and the line is 723 cents.
  v_line_total := pg_catalog.round(p_qty * v_units * v_price)::bigint;

  update public.order_items
  set qty = p_qty::numeric(10,3),
      line_total_cents = v_line_total
  where id = p_item_id;

  -- The subtotal is RECOMPUTED from the lines rather than adjusted by a delta,
  -- so it cannot drift from them however many edits an order collects.
  -- `sum(integer)` is already `bigint` in Postgres, so the accumulation is wide
  -- before it is narrowed by the column.
  select coalesce(pg_catalog.sum(item.line_total_cents), 0)
  into v_subtotal
  from public.order_items as item
  where item.order_id = p_order_id;

  update public.orders
  set subtotal_cents = v_subtotal
  where id = p_order_id;

  -- The audit row. `order_events` is staff-readable and append-only (no insert
  -- policy exists; every writer is a definer function), so this is the record of
  -- who changed what — the one thing a paper albarán cannot reconstruct after
  -- the fact. Quantities are trimmed of trailing zeroes so the row reads `1` and
  -- `5.2` rather than `1.000` and `5.200`.
  v_detail := pg_catalog.jsonb_build_object(
    'item_id', p_item_id,
    'old_qty', pg_catalog.trim_scale(v_old_qty),
    'new_qty', pg_catalog.trim_scale(p_qty)
  );
  if v_note is not null then
    v_detail := v_detail || pg_catalog.jsonb_build_object('note', v_note);
  end if;

  insert into public.order_events (order_id, event, detail, actor)
  values (p_order_id, 'line_adjusted', v_detail, (select auth.uid()));

  return true;
end
$$;

-- The repo idiom: strip the default grants, then hand back exactly the two roles
-- that may call it. `authenticated` is deliberate and gated — the function
-- refuses anyone `private.is_staff()` says no to, and it records `auth.uid()` as
-- the actor, which a service-role call could not do. It is the FOURTH definer
-- function signed-in users can execute, and the security advisor's WARN for it
-- is an accepted baseline entry (see CLAUDE.md), not a regression.
revoke all on function public.staff_update_order_line(uuid, bigint, numeric, text)
  from public, anon, authenticated;
grant execute on function public.staff_update_order_line(uuid, bigint, numeric, text)
  to authenticated, service_role;
