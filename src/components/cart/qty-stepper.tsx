"use client";

import { useTranslations } from "next-intl";
import { STEPPER, STEPPER_BTN } from "@/components/ui";
import { useCart } from "./cart-provider";

/**
 * The catalogue row's add control: a single `+` until the product is in the
 * cart, then the `− n +` pill in its place — TOKACHI's `quick-add-button.tsx`,
 * adapted to a cookie cart.
 *
 * It replaces a `<form action={addToCart}>` per row. Everything the form used
 * to say still gets said: the same two aria labels (`cart.add` when the row can
 * be ordered, `cart.addNoPrice` when it cannot), the same `title` naming the
 * price as the blocker, the same disabled `+`. What changes is that the press
 * no longer costs the customer the page they were on.
 *
 * **`−` at 1 removes the line**, back to a bare `+`. That is the cart's own
 * contract (`setQty` at 0 deletes) and TOKACHI's, so the pill has no dead
 * bottom rung and the row needs no second control to undo an accidental add.
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

  const qty = qtyOf(productId);
  const addLabel = priced
    ? t("add", { name })
    : t("addNoPrice", { name });
  const addTitle = priced ? undefined : tCatalog("noPrice");

  if (qty <= 0) {
    return (
      <button
        type="button"
        disabled={!priced}
        aria-label={addLabel}
        title={addTitle}
        onClick={() => setQty(productId, 1)}
        className="rounded-lg border border-border bg-white/70 px-2 py-1 text-base leading-none transition-colors hover:border-brand hover:text-brand-ink disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-border disabled:hover:text-ink"
      >
        +
      </button>
    );
  }

  return (
    <div className={STEPPER}>
      <button
        type="button"
        aria-label={t("decreaseFor", { name })}
        onClick={() => setQty(productId, qty - 1)}
        className={STEPPER_BTN}
      >
        −
      </button>
      {/* Announced on change, so a screen reader hears the new quantity without
          the button labels having to carry it. */}
      <span
        aria-live="polite"
        className="min-w-6 text-center text-sm font-semibold tabular-nums"
      >
        {qty}
      </span>
      <button
        type="button"
        disabled={!priced}
        aria-label={addLabel}
        title={addTitle}
        onClick={() => setQty(productId, qty + 1)}
        className={STEPPER_BTN}
      >
        +
      </button>
    </div>
  );
}
