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
