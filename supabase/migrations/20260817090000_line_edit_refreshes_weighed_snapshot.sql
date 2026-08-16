-- staff_update_order_line v2: an accepted edit re-stamps the line's own flag.
--
-- FROM A LIVE INCIDENT, order 1007 (2026-08-16). The owner flagged F-003 as
-- weighed AFTER the order was placed. A staff member then set the real weight,
-- 5.2 kg, and v1 accepted it — correctly, because it judges a quantity against
-- `coalesce(product.is_weighed, item.is_weighed)`, and the PRODUCT is the
-- authority on whether an article is sold by weight.
--
-- What it did not do is write that judgement down. `order_items.is_weighed`
-- still said false — the value copied at submit, before the toggle — and the
-- claim payload is built from `order_items`. So the bridge received a line
-- carrying `qty = 5.2` and `is_weighed = false`, which its own defensive check
-- reads as data corruption (no portal write path can produce a fraction on a
-- non-weighed line) and refuses:
--
--     BAD_QTY_STEP: codart F-003 is not weighed but has fractional qty 5.2
--
-- That refusal is right, and it is also a POISON LOOP: the lease expires, the
-- order is claimed again, the same payload fails the same way, forever. The
-- order had to be unstuck by hand.
--
-- The disagreement is the bug, not either half of it. Two rows described the
-- same line — one live, one snapshotted — and only one of them was consulted
-- when the edit was allowed. So the accepted edit now refreshes the snapshot to
-- the exact value the validation used: after this, the line records the terms
-- under which it was LAST JUDGED, and the payload the bridge reads can no longer
-- disagree with what the RPC let through.
--
-- Nothing else moves. `unit_price_cents` and `units_per_case` stay frozen (they
-- are the money the customer agreed to), the gates and error codes are v1's, and
-- the arithmetic is unchanged. No backfill either: rewriting `is_weighed` across
-- orders nobody has edited would restate the terms of pedidos that are already
-- in Wingest. Only an edit — a staff member deciding this line, now — moves it.
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
  v_old_weighed boolean;
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

  -- The order row is LOCKED, not merely read: two staff members editing two
  -- lines of the same order would otherwise both sum the lines as they found
  -- them and the second write would be missing the first one's line.
  select ord.status
  into v_status
  from public.orders as ord
  where ord.id = p_order_id
  for update;

  if not found or v_status <> 'submitted' then return false; end if;

  -- `units_per_case` and `unit_price_cents` come off the ITEM (frozen at submit);
  -- `is_weighed` comes off the PRODUCT, live, because it is the rule for what a
  -- quantity may look like and the product admin's toggle has to reach orders
  -- already waiting in the queue. The item's snapshot is the fallback for a
  -- product row deleted out from under a historic line.
  --
  -- Both are read: the coalesced value is what judges the quantity below AND
  -- what the line is re-stamped with, while the snapshot as it stands is kept
  -- only to notice whether that re-stamp changes anything worth recording.
  select
    item.codart,
    item.qty,
    item.units_per_case,
    item.unit_price_cents,
    coalesce(product.is_weighed, item.is_weighed),
    item.is_weighed
  into v_codart, v_old_qty, v_units, v_price, v_weighed, v_old_weighed
  from public.order_items as item
  left join public.products as product on product.id = item.product_id
  where item.id = p_item_id
    and item.order_id = p_order_id;

  if not found then raise exception 'BAD_LINE'; end if;

  -- The quantity rules are `create_order`'s, verbatim, down to the error codes.
  if p_qty is null
     or p_qty::text = 'NaN'
     or p_qty <= 0
     or pg_catalog.scale(p_qty) > 3 then
    raise exception 'BAD_QTY';
  end if;
  if not v_weighed and p_qty <> pg_catalog.trunc(p_qty) then
    raise exception 'BAD_QTY_STEP:%', v_codart;
  end if;
  if p_qty * v_units > 1000000 then
    raise exception 'BAD_QTY';
  end if;

  v_line_total := pg_catalog.round(p_qty * v_units * v_price)::bigint;

  -- THE FIX. `is_weighed` travels with the quantity it justified: the bridge
  -- builds its payload from this row, and a row that says 5.2 must also say why
  -- 5.2 was allowed. Writing the coalesced value — not `true`, and not the
  -- product's value read a second time — is what makes the two exactly equal,
  -- including the deleted-product case where the fallback is this same column.
  update public.order_items
  set qty = p_qty::numeric(10,3),
      line_total_cents = v_line_total,
      is_weighed = v_weighed
  where id = p_item_id;

  -- RECOMPUTED from the lines rather than adjusted by a delta, so it cannot
  -- drift from them however many edits an order collects.
  select coalesce(pg_catalog.sum(item.line_total_cents), 0)
  into v_subtotal
  from public.order_items as item
  where item.order_id = p_order_id;

  update public.orders
  set subtotal_cents = v_subtotal
  where id = p_order_id;

  v_detail := pg_catalog.jsonb_build_object(
    'item_id', p_item_id,
    'old_qty', pg_catalog.trim_scale(v_old_qty),
    'new_qty', pg_catalog.trim_scale(p_qty)
  );
  if v_note is not null then
    v_detail := v_detail || pg_catalog.jsonb_build_object('note', v_note);
  end if;
  -- Recorded ONLY when the re-stamp actually changed the line, which keeps the
  -- event shape what it was for an ordinary edit and makes the key mean
  -- something when it does appear: this is the moment a line stopped being
  -- counted in cajas and started being counted in kilos (or the reverse), and it
  -- is exactly the transition that stranded order 1007.
  if v_weighed is distinct from v_old_weighed then
    v_detail := v_detail || pg_catalog.jsonb_build_object('is_weighed', v_weighed);
  end if;

  insert into public.order_events (order_id, event, detail, actor)
  values (p_order_id, 'line_adjusted', v_detail, (select auth.uid()));

  return true;
end
$$;

-- `create or replace` keeps every grant; the block is restated per the repo
-- idiom. Unchanged from v1: the function refuses anyone `private.is_staff()`
-- says no to, and records `auth.uid()` as the actor, which a service-role call
-- could not do. It remains the fourth definer function signed-in users may
-- execute, and its advisor WARN remains an accepted baseline entry (CLAUDE.md).
revoke all on function public.staff_update_order_line(uuid, bigint, numeric, text)
  from public, anon, authenticated;
grant execute on function public.staff_update_order_line(uuid, bigint, numeric, text)
  to authenticated, service_role;
