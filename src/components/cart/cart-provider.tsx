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
import { setCartLineQty, type CartErrorCode } from "@/app/actions/cart";
import { trySetQty, type Cart } from "@/lib/cart";
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
 * Borrowed wholesale from TOKACHI's cart (`components/cart/cart-context.tsx`,
 * `quick-add-button.tsx`): press-to-stepper in place, feedback that stays on
 * the page, a header count and a bottom bar reading one shared value. What is
 * NOT borrowed is where the cart lives — TOKACHI keeps its own in
 * `localStorage` and prices it with a server call; DADA's has always been an
 * httpOnly cookie the browser cannot read, and it stays that way.
 */

/** `full`/`qty` come from the server; `writeFailed` is a request that never landed. */
export type CartError = CartErrorCode | "writeFailed";

type CartContextValue = {
  /** 0 when the product is not in the cart. Fractions are real (weighed goods). */
  qtyOf: (productId: string) => number;
  /** The badge number: LINES, not units — what the header has always counted. */
  count: number;
  /**
   * Cents, or null when this page did not price every line in the cart. See
   * `cartSubtotalCents`: no price is ever derived here.
   */
  subtotalCents: number | null;
  /** Absolute quantity for one line; 0 removes it. Optimistic, then authoritative. */
  setQty: (productId: string, qty: number) => void;
  /** The last refusal, or null. Cleared by the next write that succeeds. */
  error: CartError | null;
};

const CartContext = createContext<CartContextValue | null>(null);

export function useCart(): CartContextValue {
  const value = useContext(CartContext);
  if (!value) {
    throw new Error(
      "useCart must be used inside <CartProvider> (mounted by AppShell for nav=customer)",
    );
  }
  return value;
}

export function CartProvider({
  cart,
  prices,
  children,
}: {
  /** The server-parsed cookie. New object every render; that is the point. */
  cart: Cart;
  /**
   * Unit price in cents for the products THIS page rendered, and only those.
   * The bar shows a subtotal when it covers every line and stays count-only
   * when it does not.
   */
  prices: Record<string, number>;
  children: ReactNode;
}) {
  const [optimisticCart, applyChange] = useOptimistic(
    cart,
    (current: Cart, change: { productId: string; qty: number }) =>
      trySetQty(current, change.productId, change.qty),
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
        applyChange({ productId, qty });
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

  const value = useMemo<CartContextValue>(
    () => ({
      qtyOf: (productId: string) => optimisticCart[productId] ?? 0,
      count: Object.keys(optimisticCart).length,
      subtotalCents: cartSubtotalCents(optimisticCart, prices),
      setQty,
      error,
    }),
    [optimisticCart, prices, setQty, error],
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
