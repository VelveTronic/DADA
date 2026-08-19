"use client";

import { useTranslations } from "next-intl";
import { useState, type ReactNode } from "react";
import { BTN_QUIET, FIELD_SM } from "@/components/ui";
import { formatEuros } from "@/lib/money";
import { useCart } from "./cart-provider";

/**
 * The cart page's client leaves — its per-line controls and its subtotal —
 * moved onto the provider so the page and the catalogue stay one cart without a
 * navigation between them.
 *
 * **Who gets which control changed with design 02, and only for one kind of
 * line.** A whole-unit line now carries the catalogue's own `− n +`
 * (`QtyStepper`), because the cart page and the catalogue are the same list of
 * the same products and had no business editing them two different ways. The
 * typed box below survives for WEIGHED goods, which is the case a stepper cannot
 * express at all: 2.75 kg is not two presses of `+` away from anything. Both
 * still write the same `setQty` (absolute, 0 removes), and the `×` is still
 * beside them — for a weighed line it is the only way out, since `min` never
 * reaches 0.
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
 * The quantity box, now the WEIGHED line's control and nothing else's. Commits
 * on Enter or on "Actualizar", exactly as the form it replaces did — NOT on
 * every keystroke, which would spend a round trip per digit of a three-digit
 * order.
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
    // STACKED on a phone, inline from `sm` up, and the stack is what keeps the
    // product name legible on a weighed row. Side by side this form is the 96px
    // box plus a 4px gap plus 更新 — 42px in Chinese but 80px in Spanish, where
    // the word is "Actualizar" — and on a 390px screen every one of those pixels
    // comes out of the name column two tracks to its left: 118px on an ordinary
    // row, 66px on a Spanish weighed one, which is three characters and an
    // ellipsis. Stacked, the control is exactly as wide as the box (96px = the
    // stepper's own track), so EVERY row in the list gives its name the same
    // 118px whatever is in the action column. It costs no height either: the
    // stack is ~60px against a row that is already ~104px tall (a two-line name,
    // the meta line and the amount). Above `sm` the row has width to spare and
    // the pair goes back on one line.
    <form
      className="flex flex-col items-end gap-1 sm:flex-row sm:items-center"
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
        // 6rem — the same 96px the stepper occupies on every other row, which is
        // what the stack above is for.
        className={`w-24 ${FIELD_SM} text-right`}
      />
      <button type="submit" className={BTN_QUIET}>
        {t("update")}
      </button>
    </form>
  );
}

/**
 * The order's running total, from the provider rather than from the server
 * render — otherwise removing a line makes the row vanish while the figure
 * still counts the line for another round trip, which is the one moment the
 * page would be visibly lying about money.
 *
 * It is the SAME arithmetic, not a second opinion: this page hands the provider
 * a price for exactly the lines whose `totalCents` the server resolved
 * (orderable AND priced), and `cartSubtotalCents` sums the same rounded line
 * totals and answers null under exactly the condition that made the server's
 * `priceable` false. Nothing is derived here — the unit prices are the ones
 * this render already put on screen.
 *
 * It draws no size and no colour of its own any more: design 02 moved it off
 * its own 18px row and into the SUB-LINE of the fixed submit bar, after the
 * unit count, where the type is the bar's 11px and the ink is the bar's. All it
 * keeps is the numeral face and tabular figures, so the amount cannot jog
 * sideways as it ticks. The page names it for screen readers on the way in (the
 * visible 小计 label went with the row), and a cart this page could not price
 * end to end shows the dash rather than a total that quietly drops a line.
 */
export function CartSubtotal({ locale }: { locale: string }) {
  const { subtotalCents } = useCart();
  return (
    <span className="font-num tabular-nums">
      {subtotalCents == null ? "—" : formatEuros(subtotalCents, locale)}
    </span>
  );
}

/**
 * The `×`. Absolute quantity 0 is what removes a line, here as everywhere.
 *
 * A 36px box rather than the loose `px-2` it was: it now sits at the end of the
 * row's action column, a `gap-x-3` away from a `−` square (or from a weighed
 * line's 更新), and two adjacent controls with nothing in common need a target
 * that is a target rather than a glyph with padding round it. Same size and the
 * same reasoning as the catalogue row's favourite star — short of 44px because
 * the pixels would come straight off the product name, comfortably past WCAG
 * 2.2 AA's 24px minimum — and it costs the row no height either: the 44px
 * thumbnail beside it is taller.
 */
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
      className="inline-flex size-9 shrink-0 items-center justify-center rounded-full text-lg leading-none text-muted transition-colors hover:bg-brand-soft hover:text-brand-ink"
    >
      ×
    </button>
  );
}
