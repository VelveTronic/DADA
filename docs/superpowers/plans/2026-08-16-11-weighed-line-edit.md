# Weighed Products & Staff Line Editing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Staff can edit order-line quantities in the confirmation queue before confirming (the weighed-goods workflow: customer orders an estimate, warehouse weighs, staff set the real kg, money recalculates), and staff can flag products as weighed from the product admin.

**Architecture:** One SECURITY DEFINER RPC `staff_update_order_line` (staff-gated, `submitted` status only, recomputes line and order totals server-side, writes an `order_events` audit row) + inline qty inputs on the queue's pending cards. `products.is_weighed` already exists (boolean, no data source — freepos and Wingest both lack it); the product admin gains a 称重 toggle next to the existing 停售 switch. The bridge needs NOTHING: fractional qty already flows (`numeric(10,3)` end-to-end, injector's `baseUnitsForLine` tested with fractional qty × factor 1), and weighed products carry `units_per_case=1` with `PREVEN` = per-KG price — Wingest's own KILO convention.

**Business rule (owner, 2026-08-12 + 2026-08-16):** 称重商品备货后改重量/价格. Customer-side stays simple (order by unit/estimate); the REAL quantity is set by staff at confirmation time. Example: 柠檬 F-003 €1.39/kg, customer orders 1, warehouse weighs 5.2 kg, staff edit → line €7.23, confirm, inject CANSER=5.2.

**Scope guards:** qty edits allowed on ANY line of a `submitted` order (covers weighed goods AND partial-stock adjustments); weighed lines accept up to 3 decimals, non-weighed stay integers; qty must be > 0 (line removal is out of scope — cancel the order instead, note in code); after `confirmed` the order is locked (the bridge may claim it any minute). Editing does NOT touch unit_price_cents or units_per_case — price changes are not this feature.

---

### Task 1: staff_update_order_line RPC + queue inline editing

**Files:**
- Create: `supabase/migrations/<timestamp>_staff_update_order_line.sql`
- Modify: `src/app/actions/staff-orders.ts` (new action), `src/app/[locale]/staff/pedidos/page.tsx` (pending-card line rows), `messages/{zh,es}.json`
- Create: `src/app/[locale]/staff/pedidos/line-qty-form.tsx` (client, small)
- Test: extend `src/lib/orders` tests if a pure validator is extracted (do extract one: `validateLineQty(qty, isWeighed)` → integer check vs 3-decimals check, > 0, ≤ 9999; table-driven tests)

- [ ] **Migration**: `staff_update_order_line(p_order_id uuid, p_item_id uuid, p_qty numeric, p_note text default null)` SECURITY DEFINER, `search_path=""`; gates: caller `private.is_staff()` else `NOT_STAFF`; order exists and `status='submitted'` else `BAD_STATE`; item belongs to order else `BAD_LINE`; qty valid per the product's `is_weighed` (read via the item's product: integer when not weighed, `scale(qty)<=3` when weighed — reuse the exact checks `create_order` applies, same error codes `BAD_QTY`/`BAD_QTY_STEP`) and `qty*units_per_case<=1000000` (`BAD_QTY` roof, same as create_order v3); recompute `line_total_cents = round(p_qty * units_per_case * unit_price_cents)::bigint` guarded to int, update the item, recompute `orders.subtotal_cents` as the sum of lines (bigint intermediate), insert an `order_events` row (read the existing event-shape convention from the staff_confirm/cancel RPCs — actor, type e.g. `line_adjusted`, detail jsonb with item_id/old_qty/new_qty and the optional note). EXECUTE grants: authenticated + service_role, revoke per idiom. Apply via MCP; classifier block → report BLOCKED. Regenerate types. The security-advisor baseline gains ONE intentional WARN (a fourth definer RPC executable by authenticated) — update the CLAUDE.md baseline line in the same commit.
- [ ] **Action** `updateOrderLineQty` in staff-orders.ts following that file's exact conventions (assertStaff, rpcResult redirect param, revalidatePath) — the RPC enforces everything; the action just shapes formData and maps error codes.
- [ ] **Queue UI**: in the PENDING tab's card, each line gains a compact qty `<input type="number">` (weighed: `step="0.001"`, label suffix **KG**, the line highlighted with the existing 称重 badge; non-weighed: `step="1"`) + a per-line 保存 button posting the action; the card's totals re-render from the DB after revalidate (no client math). Confirmed/cancelled/injected cards render read-only exactly as today. Error codes → bilingual messages (`staff.orders.lineResults.*` or fold into the existing namespace — follow the file's pattern).
- [ ] Gate (bridge:build → lint → typecheck → test → build, all zero); commit `feat(staff): edit order-line quantities before confirmation` + Co-Authored-By line.

### Task 2: 称重 toggle in product admin (+ optional bulk backfill path)

**Files:**
- Modify: `src/app/[locale]/staff/productos/page.tsx` (+ its action file — read how the 停售/变体 toggles are wired and mirror exactly), `messages/{zh,es}.json`

- [ ] Toggle 称重/Por peso beside the existing switches; writes `products.is_weighed` via the same gated service-role path the other toggles use. When flipped ON the catalog immediately: shows the 称重 badge (already renders), allows decimal qty in cart (`create_order`'s BAD_QTY_STEP branch already keys off `is_weighed` — verify, don't change), displays unit as-is (unit text stays whatever Wingest says; do NOT invent a KG relabel — the weighed badge carries the meaning).
- [ ] NOTE in the report (not code): when the owner supplies the weighed-codart list, the bulk path is one SQL UPDATE via MCP — no script needed.
- [ ] Gate; commit `feat(staff): weighed-product toggle in product admin` + Co-Authored-By line.

---

## Self-review notes
- Money: multiplication only, bigint intermediates, same roofs as create_order v3; subtotal recomputed from lines (no drift).
- Race with the bridge: edits gated to `submitted`; `bridge_claim_confirmed` only claims `confirmed` — no window where an edit lands on a claimed order.
- The customer sees post-edit totals on /pedidos automatically (same rows).
- Injection: fractional CANSER for weighed goods matches Wingest KILO lines; SUBTOT invariant in the injector keeps holding because the portal snapshot IS the source.
- Out of scope, recorded: line removal, price editing, editing after confirmation (would need un-claim semantics), catalog per-KG price display copy.
