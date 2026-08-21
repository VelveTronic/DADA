-- Dissolve the variant groups (owner, 2026-08-21).
--
-- The freepos import grouped articles by a derived `base_sku` and promoted ONE
-- of each group to `is_current_variant`, which is what the customer catalogue
-- lists. The owner's ruling: those groups are wrong for this business. F-008
-- (oranges by the case) and F-008A (juicing oranges) are DIFFERENT products,
-- both stocked, both orderable — and F-008AT exists only so one product can be
-- filed under a second category. Suppressing 464 available products because a
-- suffix made them look like variants of each other cost real orders.
--
-- So every product becomes its own group of one: `base_sku = codart`,
-- `variant_suffix = ''`, `is_current_variant = true`. That keeps every existing
-- guarantee intact rather than dropping columns the whole catalogue reads:
--
--   * `products_codart_composition` (codart = base_sku || variant_suffix) holds,
--     because codart = codart || ''.
--   * `products_one_current_variant`, the partial unique index on base_sku, holds
--     trivially — base_sku is now codart, which is already unique.
--   * `is_orderable` (generated: is_available AND is_current_variant) collapses
--     to is_available, which is the whole point: what staff mark available is
--     what customers can order.
--
-- **Two statements, and the order is load-bearing.** A single UPDATE can trip
-- the partial unique index mid-statement: where a group's leader carries a
-- SUFFIXED codart (the seed's rule prefers an available suffixed row over an
-- unavailable bare one), the bare row would take `base_sku = codart` and become
-- current while the leader still holds that same base_sku as current. Clearing
-- the flag on every row first empties the partial index; the second statement
-- then refills it one distinct codart at a time, so no intermediate state
-- collides. Both run in this migration's transaction.
--
-- `scripts/import-freepos.ts` still derives groups (`selectCurrentVariants`) and
-- would undo this if re-run. It is bootstrap-only — the freepos snapshot was a
-- one-time seed — and re-running it was already documented as unsafe because it
-- overwrites hand-set availability. The nightly `price-sync` does NOT touch
-- these three columns and is unaffected.

update public.products set is_current_variant = false where is_current_variant;

update public.products
   set base_sku = codart,
       variant_suffix = '',
       is_current_variant = true;
