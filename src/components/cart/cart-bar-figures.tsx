"use client";

import { useTranslations } from "next-intl";
import { formatEuros } from "@/lib/money";
import { useCart } from "./cart-provider";

/**
 * The left column of the cart page's fixed submit bar: 3 种商品 over 合计 12 件 ·
 * 128,40 €. One client leaf for all three figures, and that is the whole point
 * of it.
 *
 * **ONE clock.** The bar used to read its counts off the SERVER — `rows.length`
 * and `cartUnits(cart)`, both computed from the cookie the render was built on —
 * with the optimistic subtotal on the end of the same line. Press × on a line
 * and the row vanished at once (the list is optimistic), the amount dropped at
 * once, and the two counts beside it went on describing the cart that no longer
 * existed until the cookie's render landed: 2 种商品 / 合计 2 件 · €10,00 for a
 * whole round trip, a sentence in which every figure is true of a different
 * moment. Read from the provider they cannot disagree — the same optimistic cart
 * answers all three, so the line either describes the cart before the press or
 * the cart after it, and never half of each.
 *
 * **What deliberately did NOT move.** The submit button beside this column is
 * still the server's: `disabled` is computed from the cookie the server read
 * (`priceable` in `carrito/page.tsx`), because a button enabled ahead of the
 * cookie is a button that submits an order the server is about to refuse. So the
 * bar now carries both clocks on purpose — a description of the cart that keeps
 * up with the customer's thumb, and a control that waits for the cookie. The
 * lag that leaves is one beat on the BUTTON, which is the conservative
 * direction; the figures no longer pay for it.
 *
 * It draws no size and no colour of its own beyond the bar's: the type is 12px
 * over 11px in the bar's muted ink, the count is the design's Archivo 18px, and
 * the amount keeps the numeral face and tabular figures so it cannot jog
 * sideways as it ticks. (`CartSubtotal`, which used to be a leaf of its own in
 * `cart-line.tsx`, is the tail of the second line here — it had exactly one
 * caller and being alone was what let the counts beside it drift.)
 */
export function CartBarFigures({
  locale,
  showPrices,
}: {
  locale: string;
  /** The owner's `show_prices` setting, as the page read it — server truth. */
  showPrices: boolean;
}) {
  const { count, units, subtotalCents } = useCart();
  const t = useTranslations("cart");

  return (
    <div className="min-w-0">
      {/* `<n>` is a TAG rather than a value because only a tag can carry markup
          through a translation, and the count and its unit have to stay in one
          sentence for a translator (the Spanish one is a plural). */}
      <p className="truncate text-xs text-muted">
        {t.rich("kindsCount", {
          lines: count,
          n: (chunks) => (
            <b className="font-num text-lg font-bold tabular-nums">{chunks}</b>
          ),
        })}
      </p>
      {/* The mockup paints this line in the design's faintest grey, and this is
          one of the places the repo does not follow it. `text-faint` is #A8A099,
          2.58:1 on the white bar, and `globals.css` licenses that token for
          placeholders and for text that repeats what a label already said —
          neither of which this line is any more. The subtotal row is GONE from
          this page, so the amount at the end of it is the only place the cart's
          money is written, and 合计 N 件 is the only place the units are.
          `text-muted` is the same warm grey a shade darker (5.57:1 on white) and
          clears AA. Same call as the tab bar's labels and the /cuenta card. */}
      <p className="truncate text-[11px] text-muted">
        {t("unitsTotal", { n: units })}
        {" · "}
        {showPrices ? (
          <>
            {/* The visible 小计 label went with the subtotal row this bar
                replaced, so it is said here for screen readers only: an amount
                at the end of a line of counts does not say what it is the total
                of. */}
            <span className="sr-only">{t("subtotal")}: </span>
            {/* The SAME arithmetic as the server's, not a second opinion: the
                page hands the provider a price for exactly the lines whose
                `totalCents` it resolved (orderable AND priced), and
                `cartSubtotalCents` sums the same rounded line totals and answers
                null under exactly the condition that made `priceable` false.
                Nothing is derived here — the unit prices are the ones this
                render already put on screen. A cart this page could not price
                end to end shows the dash rather than a total that quietly drops
                a line. */}
            <span className="font-num tabular-nums">
              {subtotalCents == null ? "—" : formatEuros(subtotalCents, locale)}
            </span>
          </>
        ) : (
          // Not a blank where the money was: with the owner's switch off this
          // portal is a demand list, and saying so is the point of the line.
          t("noPayment")
        )}
      </p>
    </div>
  );
}
