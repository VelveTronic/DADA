"use server";

import { hasLocale } from "next-intl";
import { refresh, revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { routing } from "@/i18n/routing";
import { getSessionUser } from "@/lib/auth/session";
import type { Cart, ReorderLine } from "@/lib/cart";
import {
  CART_COOKIE,
  isProductId,
  mergeReorderLines,
  parseCart,
  serializeCart,
  setQty,
} from "@/lib/cart";
import { isUuid } from "@/lib/orders";
import { perfRun } from "@/lib/perf";
import { createServerSupabase } from "@/lib/supabase/server";

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

/**
 * 再来一单 — copy a past order's lines into the cart, and land on the cart page
 * with a count of what arrived.
 *
 * **It writes the cookie and nothing else.** No order is created, nothing is
 * submitted and no price travels: the merge stores quantities against product
 * ids exactly as a `+` in the catalogue does, and every price on the cart page
 * after it is re-resolved from the company's tarifa — as `create_order` will
 * resolve them again at submit (CLAUDE.md). The customer still presses
 * 提交需求单 themselves.
 *
 * **Four reads in three rounds, none of them trusted from the form.** The
 * ownership check and the lines go out together; everything else has to wait for
 * what the read before it answered. The company is read
 * server-side from `portal_users` (the form carries an order id and a locale,
 * and that is all it is allowed to carry), the order is then confirmed to BELONG
 * to that company, and the products are checked against `products_priced` for
 * whether they can still be ordered at all. `orders_read` and `order_items_read`
 * already narrow both tables to the caller's own restaurant — `order_items` is
 * customer-readable through its parent order's company (migration
 * `20260815101406`) — so the explicit `company_id` filter is the same
 * belt-and-suspenders the history page uses: it says out loud whose order is
 * being copied.
 *
 * **Every refusal is silent and lands on the history.** A missing session, an
 * order id that is not this restaurant's, a read that failed: all of them go
 * back to `/pedidos` with no banner, because there is nothing the customer can
 * do about any of them and a crafted POST deserves no answer. What DOES get
 * reported is the honest partial: how many lines were added and how many could
 * not be, which is the pair the cart page's banner reads.
 */
export async function reorderIntoCart(formData: FormData): Promise<void> {
  const perf = perfRun("action:cart.reorder");
  const locale = safeLocale(formData.get("locale"));
  const historyHref = `/${locale}/pedidos`;
  const orderId = String(formData.get("order_id") ?? "");
  // A server action is reachable by a crafted POST, so the id is checked for
  // SHAPE here — it reaches `.eq("id", …)` on a uuid column, where anything else
  // comes back as a cast error rather than as no rows.
  if (!isUuid(orderId)) redirect(historyHref);

  const user = await perf.step("session", getSessionUser());
  if (!user) redirect(`/${locale}/login`);

  const supabase = await createServerSupabase();
  const { data: portalUser, error: profileError } = await perf.step(
    "profile",
    supabase
      .from("portal_users")
      .select("company_id")
      .eq("id", user.id)
      .maybeSingle(),
  );
  if (profileError) console.error("reorderIntoCart profile:", profileError);
  if (!portalUser) redirect(historyHref);

  // Both on the wire together. The lines can be fetched before the ownership
  // check has answered because `order_items_read` is the thing that actually
  // decides whether they come back at all — the check beside it is what turns a
  // stranger's order id from "an empty card" into "back to your history".
  const [orderResult, itemResult] = await Promise.all([
    perf.step(
      "order",
      supabase
        .from("orders")
        .select("id")
        .eq("id", orderId)
        .eq("company_id", portalUser.company_id)
        .maybeSingle(),
    ),
    perf.step(
      "lines",
      supabase
        .from("order_items")
        .select("product_id, qty")
        .eq("order_id", orderId)
        // The order the customer placed them in, which is the order the cart
        // page will list them in.
        .order("sort_order", { ascending: true }),
    ),
  ]);
  if (orderResult.error) console.error("reorderIntoCart order:", orderResult.error);
  if (!orderResult.data) redirect(historyHref);
  if (itemResult.error) console.error("reorderIntoCart lines:", itemResult.error);

  // `order_items.product_id` is a NULLABLE column (`0003_orders.sql`) — the line
  // is a snapshot and keeps its codart, name and price whatever happens to the
  // catalogue — so the read has to narrow it. Today the FK is `no action`, so
  // nothing can actually clear it; if that ever changes, a line with no product
  // is dropped here rather than counted as skipped, because the customer would
  // be told something could not be added with nothing on the screen to name it.
  const lines: ReorderLine[] = [];
  for (const item of itemResult.data ?? []) {
    if (item.product_id) lines.push({ product_id: item.product_id, qty: item.qty });
  }

  // What is still orderable TODAY, which the order's own snapshot cannot answer:
  // `is_orderable` is generated (`is_available AND is_current_variant`) and the
  // article may have been paused or superseded since. The customer view, so no
  // price column is even in the answer.
  const productIds = [...new Set(lines.map((line) => line.product_id))];
  const orderableIds = new Set<string>();
  if (productIds.length > 0) {
    const { data, error } = await perf.step(
      "products",
      supabase
        .from("products_priced")
        .select("id, is_orderable")
        .in("id", productIds),
    );
    if (error) console.error("reorderIntoCart products:", error);
    for (const product of data ?? []) {
      // The view widens every column to `| null`; keying off the narrowed value
      // avoids a cast, exactly as the cart page does it.
      if (product.id && product.is_orderable) orderableIds.add(product.id);
    }
  }

  const { cart, added, skipped } = mergeReorderLines(
    await readCart(),
    lines,
    orderableIds,
  );
  // Nothing added is nothing to write: an unchanged cart should not spend a
  // `Set-Cookie` on saying so. The banner still reports the skipped lines.
  if (added > 0) await writeCart(cart);
  // Both customer surfaces, as every other cart write revalidates them: the
  // press happened on `/pedidos` and the answer is rendered by `/carrito`, so
  // `refresh()` — which re-renders the route the action was called from — is the
  // wrong tool here. Same reasoning as `clearCart`'s.
  revalidateCart(locale);
  perf.end();
  redirect(`/${locale}/carrito?readded=${added}&skipped=${skipped}`);
}
