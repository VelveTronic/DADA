"use client";

import { useTranslations } from "next-intl";
import { useRef } from "react";
import { STEPPER, STEPPER_BTN } from "@/components/ui";
import { useCart } from "./cart-provider";

/**
 * The catalogue row's add control: one glass pill holding a `+`, which GROWS a
 * `−` and a figure to its left once the product is in the cart — TOKACHI's
 * `quick-add-button.tsx`, adapted to a cookie cart. The pill is the same
 * element in both states; only its contents change (see the note on the
 * return).
 *
 * It replaces a `<form action={addToCart}>` per row. Everything the form used
 * to say still gets said: the same two aria labels (`cart.add` when the row can
 * be ordered, `cart.addNoPrice` when it cannot), the same `title` naming the
 * price as the blocker, the same disabled `+`. What changes is that the press
 * no longer costs the customer the page they were on.
 *
 * **`−` at 1 removes the line**, shrinking the pill back to its lone `+`. That
 * is the cart's own contract (`setQty` at 0 deletes) and TOKACHI's, so the pill
 * has no dead bottom rung and the row needs no second control to undo an
 * accidental add.
 *
 * The `+` stays disabled on an unpriced product even once a quantity exists —
 * a price can disappear after an add — but `−` never is: whatever put the line
 * there, the customer must be able to take it out.
 */
export function QtyStepper({
  productId,
  name,
  priced,
}: {
  productId: string;
  /** Already localized by the server row; it names the buttons for a screen reader. */
  name: string;
  /** False while this product still has no tarifa price. Blocks the `+`, as today. */
  priced: boolean;
}) {
  const { qtyOf, setQty } = useCart();
  const t = useTranslations("cart");
  const tCatalog = useTranslations("catalog");
  const plusRef = useRef<HTMLButtonElement>(null);

  const qty = qtyOf(productId);
  const addLabel = priced
    ? t("add", { name })
    : t("addNoPrice", { name });
  const addTitle = priced ? undefined : tCatalog("noPrice");

  // ONE wrapper for both states, and the `+` keyed inside it, so the element
  // the customer just pressed is the same DOM node before and after the 0→1
  // transition. Returning a bare <button> from one branch and a <div> from the
  // other unmounted it mid-press: the browser drops focus to <body>, and on a
  // 50-row catalogue that costs a keyboard or screen-reader user their place in
  // the list — they land back at the top and have to walk down again to press
  // `+` a second time.
  return (
    <div className={STEPPER}>
      {qty > 0 && (
        <button
          key="minus"
          type="button"
          aria-label={t("decreaseFor", { name })}
          onClick={() => {
            // The shrink direction of the same problem: at 1 this press removes
            // the line and takes THIS button with it, so hand focus to the `+`
            // that survives first — otherwise the browser drops it on <body>
            // and the keyboard user loses the row. Moving focus before the
            // state change is what makes it stick: the `+` is keyed, so it is
            // the same node on the other side of the render.
            if (qty <= 1) plusRef.current?.focus();
            setQty(productId, qty - 1);
          }}
          className={STEPPER_BTN}
        >
          −
        </button>
      )}
      {/* Announced on change, so a screen reader hears the new quantity without
          the button labels having to carry it. */}
      {qty > 0 && (
        <span
          key="qty"
          aria-live="polite"
          className="min-w-6 text-center text-sm font-semibold tabular-nums"
        >
          {qty}
        </span>
      )}
      <button
        key="plus"
        ref={plusRef}
        type="button"
        disabled={!priced}
        aria-label={addLabel}
        title={addTitle}
        onClick={() => setQty(productId, qty > 0 ? qty + 1 : 1)}
        className={STEPPER_BTN}
      >
        +
      </button>
    </div>
  );
}
