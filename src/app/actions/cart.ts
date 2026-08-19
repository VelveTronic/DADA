"use server";

import { hasLocale } from "next-intl";
import { refresh, revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { routing } from "@/i18n/routing";
import type { Cart } from "@/lib/cart";
import {
  CART_COOKIE,
  isProductId,
  parseCart,
  serializeCart,
  setQty,
} from "@/lib/cart";
import { perfRun } from "@/lib/perf";

/** 30 days: long enough that a cart survives a weekend, short enough to expire. */
const CART_MAX_AGE = 60 * 60 * 24 * 30;

/** Why a cart write was refused. Both codes already have customer-facing copy. */
export type CartErrorCode = "full" | "qty";

/**
 * What a cart write answers. The caller is a CLICK, not a form post, so a
 * refusal comes back as a value the stepper can render in place — the page it
 * happened on keeps its scroll, its search and its filter tab.
 */
export type CartWriteResult = { ok: true } | { ok: false; code: CartErrorCode };

/** The locale arrives from the client, so it is never trusted as a path segment. */
function safeLocale(value: unknown) {
  const candidate = String(value ?? routing.defaultLocale);
  return hasLocale(routing.locales, candidate)
    ? candidate
    : routing.defaultLocale;
}

async function readCart(): Promise<Cart> {
  return parseCart((await cookies()).get(CART_COOKIE)?.value);
}

/**
 * httpOnly so no script can read or forge the cart; lax so it still rides along
 * on the top-level GET that follows a redirect. Quantities only — a price never
 * goes into this cookie (CLAUDE.md: prices are never trusted from the client).
 *
 * This is the ONLY writer. The client-side cart is a mirror of what this wrote,
 * never a second copy of the truth.
 */
async function writeCart(cart: Cart): Promise<void> {
  (await cookies()).set(CART_COOKIE, serializeCart(cart), {
    httpOnly: true,
    path: "/",
    sameSite: "lax",
    maxAge: CART_MAX_AGE,
  });
}

function revalidateCart(locale: string): void {
  revalidatePath(`/${locale}/catalogo`);
  revalidatePath(`/${locale}/carrito`);
}

/**
 * Absolute quantity for one line; 0 removes it.
 *
 * **The one cart-line writer the browser can reach.** Both surfaces go through
 * it — the catalogue's `− n +` stepper and the cart page's number box — because
 * an absolute quantity is the only contract under which two of them racing
 * still ends where the customer last pointed: the presses dispatch in order
 * (React awaits Server Functions one at a time), so the last value wins and the
 * cookie holds exactly what the pill shows.
 *
 * Every argument is network input — a Server Function is reachable by a crafted
 * POST, not just through the UI — so the product id and the quantity are
 * validated here exactly as the form-data version validated its fields. There
 * is deliberately no session check, as there never was: this writes the
 * caller's OWN cookie and reads nothing. Prices, availability and the company's
 * tarifa are all re-resolved by `create_order` at submit.
 */
export async function setCartLineQty(
  productId: string,
  qty: number,
): Promise<CartWriteResult> {
  // Instrumented because the number this action is blamed for is not its own:
  // the write is a cookie, with no database in it at all, and everything the
  // customer waits for after a `+` is the `refresh()` at the bottom re-rendering
  // whichever page they pressed it on. `PERF_LOG=1` shows the two side by side —
  // this line will read a millisecond or two, and the catalogue's line right
  // after it is the real cost of the press.
  const perf = perfRun("action:cart.setQty");
  if (!isProductId(productId)) return { ok: false, code: "qty" };
  if (typeof qty !== "number" || !Number.isFinite(qty) || qty < 0) {
    return { ok: false, code: "qty" };
  }

  const cart = await readCart();
  let next: Cart;
  try {
    next = setQty(cart, productId, qty);
  } catch (error) {
    const full = error instanceof Error && error.message === "CART_FULL";
    return { ok: false, code: full ? "full" : "qty" };
  }

  await writeCart(next);
  perf.end();
  // `refresh` re-runs THIS route's dynamic render inside the same POST. That
  // second render is what the optimistic UI settles onto: the provider's base
  // cart is a prop off the freshly-read cookie, so the quantity left on screen
  // when the transition ends is the cookie's own and a hard reload cannot
  // disagree with it.
  //
  // Deliberately NOT `revalidatePath` for the sibling cart page, which is what
  // the form-data actions this replaced did. Both cart pages are
  // `force-dynamic`: there is no route-cache entry to invalidate, and the
  // router keeps dynamic entries for 0ms, so opening the other page always
  // re-renders and always reads the cookie this just wrote. Asking anyway would
  // only invalidate `/carrito` on every single `+`, inviting the router to
  // re-fetch — and re-render, with its product query — a page nobody is looking
  // at. Next's own guidance for a dynamic read is this one call
  // (`node_modules/next/dist/docs/01-app/02-guides/interactive-apps.md`,
  // "Invalidate from mutations").
  refresh();
  return { ok: true };
}

/**
 * Empty the cart. The 清空 button on the cart page, and the post-checkout reset.
 *
 * Same guard/cookie shape as its sibling above: a plain argument rather than
 * form data (both callers pass a value they already hold), the locale narrowed
 * by `safeLocale` because a Server Function is reachable by a crafted POST, and
 * `writeCart` as the one writer. It cannot be refused — an empty cart is always
 * a legal cart, so there is no `CartWriteResult` branch to answer with — and it
 * still answers in the sibling's shape so a caller awaiting either gets the
 * same thing back.
 *
 * `revalidatePath` here and NOT the sibling's `refresh()`, which is the one
 * place the two diverge. A cleared cart changes BOTH pages — the catalogue's
 * steppers drop back to a lone `+` — and revalidating from a Server Function
 * "updates the UI immediately (if viewing the affected path)"
 * (`node_modules/next/dist/docs/01-app/03-api-reference/04-functions/revalidatePath.md`),
 * so the press the customer just made re-renders `/carrito` into its empty
 * state without this action having to know which of the two it was called from.
 * That matters for the second caller: `submitOrder` clears on its way to
 * `/pedidos`, where a `refresh()` of a route nobody is on would do nothing at
 * all. One `+` cannot afford this pair (see the note above); one CLEAR — a
 * press that happens at most once per order — can.
 */
export async function clearCart(locale: string): Promise<{ ok: true }> {
  await writeCart({});
  revalidateCart(safeLocale(locale));
  return { ok: true };
}
