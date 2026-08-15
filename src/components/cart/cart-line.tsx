"use client";

import { useTranslations } from "next-intl";
import { useState, type ReactNode } from "react";
import { BTN_QUIET, FIELD_SM } from "@/components/ui";
import { useCart } from "./cart-provider";

/**
 * The cart page's three per-line controls, moved onto the provider so the page
 * and the catalogue stay one cart without a navigation between them.
 *
 * The page keeps the shape it had — an editable ABSOLUTE quantity plus an `×`,
 * not the catalogue's stepper — because a restaurant ordering 24 of something
 * types 24; it does not press `+` twenty-four times. Only the plumbing under it
 * changed: same `setCartQty` semantics (absolute, 0 removes), same labels, same
 * `step`/`min` for weighed goods, no page post.
 */

/**
 * The row itself, which vanishes the moment its quantity reaches 0.
 *
 * Without this the `×` would leave a line on screen until the server render
 * caught up — the one place where the cookie being authoritative would have
 * LOOKED like the press did nothing. `children` is the row's server-rendered
 * markup, handed through untouched.
 */
export function CartLine({
  productId,
  className,
  children,
}: {
  productId: string;
  className: string;
  children: ReactNode;
}) {
  const { qtyOf } = useCart();
  if (qtyOf(productId) <= 0) return null;
  return <li className={className}>{children}</li>;
}

/**
 * The quantity box. Commits on Enter or on "Actualizar", exactly as the form it
 * replaces did — NOT on every keystroke, which would spend a round trip per
 * digit of a three-digit order.
 *
 * The draft is dropped once a valid quantity is sent, so the field follows the
 * cart again (including a change made from the catalogue). An invalid one is
 * KEPT on screen with the banner beside it: blanking the box is an error and
 * never a silent delete — removing a line is the `×`'s job — and a customer who
 * mistyped should see what they typed.
 */
export function CartQtyInput({
  productId,
  name,
  weighed,
}: {
  productId: string;
  /** Already localized; empty when the product carries no name in either language. */
  name: string;
  weighed: boolean;
}) {
  const { qtyOf, setQty } = useCart();
  const t = useTranslations("cart");
  const [draft, setDraft] = useState<string | null>(null);
  const qty = qtyOf(productId);

  function commit() {
    const text = (draft ?? String(qty)).trim();
    const next = text === "" ? Number.NaN : Number(text);
    setQty(productId, next);
    if (Number.isFinite(next) && next >= 0) setDraft(null);
  }

  return (
    <form
      className="flex items-center gap-1"
      onSubmit={(event) => {
        event.preventDefault();
        commit();
      }}
    >
      <input
        type="number"
        value={draft ?? String(qty)}
        onChange={(event) => setDraft(event.target.value)}
        // Weighed goods are sold by fractional kilo; everything else is whole
        // units, which is also what create_order enforces (BAD_QTY_STEP).
        // Removing a line is the × button's job, so neither minimum reaches 0.
        step={weighed ? 0.001 : 1}
        min={weighed ? 0.001 : 1}
        inputMode={weighed ? "decimal" : "numeric"}
        // One "Cantidad" per row would be useless to a screen reader, so the
        // name goes in the label — unless the product carries none in either
        // language.
        aria-label={name ? t("qtyFor", { name }) : t("qty")}
        className={`w-24 ${FIELD_SM} text-right`}
      />
      <button type="submit" className={BTN_QUIET}>
        {t("update")}
      </button>
    </form>
  );
}

/** The `×`. Absolute quantity 0 is what removes a line, here as everywhere. */
export function CartRemoveButton({
  productId,
  name,
}: {
  productId: string;
  name: string;
}) {
  const { setQty } = useCart();
  const t = useTranslations("cart");

  return (
    <button
      type="button"
      aria-label={name ? t("removeFor", { name }) : t("remove")}
      onClick={() => setQty(productId, 0)}
      className="px-2 text-lg leading-none text-muted transition-colors hover:text-brand-ink"
    >
      ×
    </button>
  );
}
