/**
 * Cart = { productId: qty } in an httpOnly cookie. Quantities only — prices are
 * NEVER stored client-side (re-resolved from products_priced at render and by
 * create_order at submit). Cap keeps the cookie far under 4KB and under
 * create_order's TOO_MANY_LINES (200).
 */
export const CART_COOKIE = "dada_cart";
export const CART_MAX_LINES = 60;
const MAX_QTY = 9999;

export type Cart = Record<string, number>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A product id is only ever a uuid. Callers validate BEFORE writing, so the
 * cookie can never carry a key `parseCart` would silently drop on read — and a
 * crafted 4KB `product_id` can never reach `Set-Cookie`. It also keeps
 * `__proto__` and friends out of the plain object below.
 */
export function isProductId(value: string): boolean {
  return UUID.test(value);
}

export function parseCart(raw: string | undefined): Cart {
  if (!raw) return {};
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return {};
  const cart: Cart = {};
  for (const [id, qty] of Object.entries(data)) {
    if (!UUID.test(id)) continue;
    const n = typeof qty === "number" ? qty : Number.NaN;
    if (!Number.isFinite(n) || n <= 0 || n > MAX_QTY) continue;
    // The cap is a READ-side invariant too: a hand-crafted cookie can carry
    // hundreds of perfectly valid uuids, and no caller should ever query more
    // lines than setQty would have let anyone write.
    if (Object.keys(cart).length >= CART_MAX_LINES) break;
    cart[id] = Math.round(n * 1000) / 1000;
  }
  return cart;
}

export function serializeCart(cart: Cart): string {
  return JSON.stringify(cart);
}

/** qty <= 0 removes the line. Throws CART_FULL / BAD_QTY (caller maps to messages). */
export function setQty(cart: Cart, productId: string, qty: number): Cart {
  const next: Cart = { ...cart };
  if (qty <= 0) {
    delete next[productId];
    return next;
  }
  // NaN fails `<= 0` above and lands here, where Number.isFinite rejects it.
  if (!Number.isFinite(qty) || qty > MAX_QTY) throw new Error("BAD_QTY");
  if (!(productId in next) && Object.keys(next).length >= CART_MAX_LINES) {
    throw new Error("CART_FULL");
  }
  next[productId] = Math.round(qty * 1000) / 1000;
  return next;
}

/**
 * The UNITS in a cart: every line's quantity added up, where `count` (the
 * header badge, the demand bar's first figure) is the number of LINES.
 *
 * The bar says both — 需求单 3 种 · 12 件 — because they answer different
 * questions: how many products were picked, and how much is coming on the van.
 *
 * Rounded to three decimals for the same reason `parseCart` and `setQty` round
 * there: a weighed line is fractional, and adding fractions in binary floating
 * point produces 0.30000000000000004, which is not a quantity anybody should
 * read on a phone. Three decimals is the cookie's own precision, so nothing is
 * lost in the rounding that was not already lost on the way in.
 */
export function cartUnits(cart: Cart): number {
  let total = 0;
  for (const qty of Object.values(cart)) total += qty;
  return Math.round(total * 1000) / 1000;
}

/** One line of a past order, as 再来一单 hands it to the merge below. */
export type ReorderLine = { product_id: string; qty: number };

/** The merged cart and what became of the lines that went into it. */
export type ReorderResult = { cart: Cart; added: number; skipped: number };

/**
 * 再来一单 — merge a past order into the cart the customer already has.
 *
 * **Merge, never replace.** The cart is the customer's current intention and a
 * reorder is a shortcut for filling it, so a product that is ALREADY in the cart
 * keeps the quantity they last typed: the past order does not get to overwrite
 * this week's 3 cajas with last week's 12. Those lines count as `skipped` — a
 * deliberate outcome rather than a failure, and the reason `cart.reorderSkipped`
 * names 已在需求单 / "ya en el pedido" alongside the two that really are
 * refusals. A banner that blamed only the catalogue would be describing a
 * different function from this one.
 *
 * Three things are refused outright, all counted the same way because the
 * customer's answer to each is the same — look at the cart:
 *
 *  - a product no longer orderable (`orderableIds` is what the caller read back
 *    from `products_priced`; a discontinued or paused article is not in it, and
 *    neither is one whose row is gone entirely),
 *  - a line the cookie has no room for (`setQty` throws CART_FULL at the 60-line
 *    cap, and a big order merged into a full-ish cart hits it part way through),
 *  - a quantity `setQty` would not store — non-finite, over its own cap, or ≤ 0,
 *    which that function READS AS A REMOVAL. `create_order` cannot write a line
 *    like that, so this is a floor rather than a case; it is here because
 *    "removes an unrelated line and reports it as added" is the one way this
 *    function could do damage.
 *
 * The orderable test runs FIRST, and that ordering is load-bearing: everything
 * below it uses the id as an object key, and only an id `products_priced` just
 * answered for is known to be a real product uuid rather than something a
 * crafted row could put in front of `in`. Counts are unaffected — a line that
 * fails two tests is skipped either way.
 *
 * Pure: the cart it is handed is never mutated (`setQty` copies), so the caller
 * decides whether the result reaches the cookie.
 */
export function mergeReorderLines(
  cart: Cart,
  lines: readonly ReorderLine[],
  orderableIds: ReadonlySet<string>,
): ReorderResult {
  let next = cart;
  let added = 0;
  let skipped = 0;

  for (const line of lines) {
    if (!orderableIds.has(line.product_id) || line.product_id in next) {
      skipped++;
      continue;
    }
    if (!Number.isFinite(line.qty) || line.qty <= 0) {
      skipped++;
      continue;
    }
    try {
      next = setQty(next, line.product_id, line.qty);
      added++;
    } catch {
      // CART_FULL or BAD_QTY. Which one it was does not change the sentence the
      // customer reads, and the lines after it still get their turn: a cart that
      // filled up on line 40 of a 50-line order keeps the 39 that fitted.
      skipped++;
    }
  }

  return { cart: next, added, skipped };
}

/**
 * `setQty` that answers with the cart instead of throwing: a change the rules
 * above refuse leaves it exactly as it was.
 *
 * This is what the OPTIMISTIC client mirror runs on, and running the server's
 * own function is the point — the quantity the browser paints on the current
 * frame can never be one the cookie would then refuse, so the two cannot
 * disagree once the round trip lands. Why the change was refused still comes
 * from the server action, which is the only thing that actually wrote (or did
 * not write) the cookie.
 */
export function trySetQty(cart: Cart, productId: string, qty: number): Cart {
  try {
    return setQty(cart, productId, qty);
  } catch {
    return cart;
  }
}
