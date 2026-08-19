"use client";

import { useTranslations } from "next-intl";
import {
  createContext,
  startTransition,
  useCallback,
  useContext,
  useMemo,
  useOptimistic,
  useState,
  type ReactNode,
} from "react";
import {
  clearCart,
  setCartLineQty,
  type CartErrorCode,
} from "@/app/actions/cart";
import { cartUnits, trySetQty, type Cart } from "@/lib/cart";
import { cartSubtotalCents } from "@/lib/money";

/**
 * The cart, live, for every control under the app shell — the catalogue's
 * steppers, the header's count, the mobile bar and the cart page's own rows.
 *
 * **The cookie is still the only cart.** This context is a MIRROR, deliberately
 * built so it cannot become a second opinion:
 *
 * ```text
 *   press  →  useOptimistic paints qty on the current frame  (trySetQty, the
 *             server's own rule set — see src/lib/cart.ts)
 *          →  setCartLineQty writes the httpOnly cookie      (server, authoritative)
 *          →  refresh() re-renders this route in the same POST
 *          →  the transition ends: the optimistic layer is dropped and what
 *             stays on screen is the `cart` PROP off the cookie that was just
 *             written
 * ```
 *
 * So the only value that survives a settled interaction is the server's, and a
 * hard reload cannot disagree with the screen. A refused write is the same
 * mechanism read backwards: nothing was written, the prop comes back unchanged,
 * and dropping the optimistic layer IS the revert — all that is left for this
 * file to do is say why, which is what `error` carries.
 *
 * `clearAll` is the same pipeline with `clearCart` in the middle (which
 * revalidates BOTH cart paths instead of refreshing one — see the note on the
 * action). Every write the browser can make is in this file, and that is
 * deliberate: a component that called a cart action itself would be a second
 * writer with no optimistic layer and, worse, no catch — an uncaught rejection
 * inside a transition takes the whole route to the error boundary, and this
 * portal draws no `error.tsx` anywhere. A failed cart write must cost a banner,
 * never the screen.
 *
 * Borrowed wholesale from TOKACHI's cart (`components/cart/cart-context.tsx`,
 * `quick-add-button.tsx`): press-to-stepper in place, feedback that stays on
 * the page, a header count and a bottom bar reading one shared value. What is
 * NOT borrowed is where the cart lives — TOKACHI keeps its own in
 * `localStorage` and prices it with a server call; DADA's has always been an
 * httpOnly cookie the browser cannot read, and it stays that way.
 */

/** `full`/`qty` come from the server; `writeFailed` is a request that never landed. */
export type CartError = CartErrorCode | "writeFailed";

/**
 * What one optimistic change can be. A union and not a second `useOptimistic`:
 * a hook owns exactly ONE base state, so a clear kept in its own would paint
 * over a cart the line-level one had already changed (or the other way round)
 * and the two mirrors would disagree the moment a press landed inside a clear's
 * round trip. Both writes the browser can make go through the same reducer,
 * which is also why both settle onto the same cookie.
 */
type CartChange =
  | { kind: "qty"; productId: string; qty: number }
  | { kind: "clear" };

type CartContextValue = {
  /** 0 when the product is not in the cart. Fractions are real (weighed goods). */
  qtyOf: (productId: string) => number;
  /** The badge number: LINES, not units — what the header has always counted. */
  count: number;
  /**
   * The other figure, and the demand bar shows both: every line's quantity
   * added up. Fractions are real here too, so it is rounded — see `cartUnits`.
   */
  units: number;
  /**
   * Cents, or null when this page did not price every line in the cart. See
   * `cartSubtotalCents`: no price is ever derived here.
   */
  subtotalCents: number | null;
  /** Absolute quantity for one line; 0 removes it. Optimistic, then authoritative. */
  setQty: (productId: string, qty: number) => void;
  /**
   * Empty the whole cart — 清空, and nothing else calls it. Same mechanism as
   * `setQty` down to the catch: the failure surface is this provider's banner,
   * never a thrown promise, so a clear that never landed cannot take the page
   * down with it.
   */
  clearAll: () => void;
  /** The last refusal, or null. Cleared by the next write that succeeds. */
  error: CartError | null;
};

const CartContext = createContext<CartContextValue | null>(null);

export function useCart(): CartContextValue {
  const value = useContext(CartContext);
  if (!value) {
    throw new Error(
      "useCart must be used inside <CartProvider> (mounted by AppShell, the customer shell)",
    );
  }
  return value;
}

export function CartProvider({
  cart,
  prices,
  locale,
  children,
}: {
  /** The server-parsed cookie. New object every render; that is the point. */
  cart: Cart;
  /**
   * Price of one CAJA in cents for the products THIS page rendered, and only
   * those — the same unit `cart` counts in. The bar shows a subtotal when it
   * covers every line and stays count-only when it does not, which is also what
   * an empty map buys a page that renders no amounts at all.
   */
  prices: Record<string, number>;
  /**
   * Only `clearAll` needs it, and only to name the two paths that action
   * revalidates. It is a prop rather than a hook read for the same reason every
   * other cart leaf takes one: the shell already has it, and the action
   * re-narrows whatever arrives anyway (`safeLocale`).
   */
  locale: string;
  children: ReactNode;
}) {
  const [optimisticCart, applyChange] = useOptimistic(
    cart,
    (current: Cart, change: CartChange): Cart =>
      change.kind === "clear"
        ? {}
        : trySetQty(current, change.productId, change.qty),
  );
  const [error, setError] = useState<CartError | null>(null);

  const setQty = useCallback(
    (productId: string, qty: number) => {
      // Junk typed into the cart page's number box never becomes a round trip.
      // The server checks the same thing again; this is only the faster no.
      if (!Number.isFinite(qty) || qty < 0) {
        setError("qty");
        return;
      }
      startTransition(async () => {
        // On the current frame, before the await — `useOptimistic` setters are
        // not deferred the way `useState` setters inside a transition are.
        applyChange({ kind: "qty", productId, qty });
        try {
          const result = await setCartLineQty(productId, qty);
          setError(result.ok ? null : result.code);
        } catch {
          // A request that never landed wrote nothing, so the optimistic qty
          // drops back to the cookie's when this transition ends. Saying "bad
          // quantity" here would be a lie: the quantity was fine, the trip was not.
          setError("writeFailed");
        }
      });
    },
    [applyChange],
  );

  const clearAll = useCallback(() => {
    startTransition(async () => {
      // The same frame, the same order, the same catch as `setQty` above — the
      // one difference is that there is no refusal to render: `clearCart`
      // cannot say no (an empty cart is always a legal cart), so the only thing
      // that can go wrong is the trip itself.
      //
      // The optimistic empty is not decoration either. It is what makes 清空
      // take the list, the bar's figures and the button off screen on the press
      // rather than a round trip later — and, when the write fails, dropping
      // this layer at the end of the transition IS the revert: every line comes
      // back off the cookie that was never written, under the banner below.
      applyChange({ kind: "clear" });
      try {
        await clearCart(locale);
        setError(null);
      } catch {
        setError("writeFailed");
      }
    });
  }, [applyChange, locale]);

  const value = useMemo<CartContextValue>(
    () => ({
      qtyOf: (productId: string) => optimisticCart[productId] ?? 0,
      count: Object.keys(optimisticCart).length,
      units: cartUnits(optimisticCart),
      subtotalCents: cartSubtotalCents(optimisticCart, prices),
      setQty,
      clearAll,
      error,
    }),
    [optimisticCart, prices, setQty, clearAll, error],
  );

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

/**
 * The refusal, where the page's other banners are: at the top of `<main>`, in
 * flow, in the same red the checkout errors use. It is not dismissible and does
 * not time out — neither was the `?cartError` banner it replaces, and an error
 * that clears itself is one a busy kitchen never reads. The next write that
 * succeeds takes it down.
 */
export function CartErrorBanner() {
  const { error } = useCart();
  const t = useTranslations("cart");
  if (!error) return null;
  return (
    <p
      role="alert"
      className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700"
    >
      {error === "full"
        ? t("full")
        : error === "qty"
          ? t("badQty")
          : t("writeFailed")}
    </p>
  );
}
