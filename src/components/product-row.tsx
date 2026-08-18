import type { Locale } from "next-intl";
import { getTranslations } from "next-intl/server";
import { toggleFavorite } from "@/app/actions/favorites";
import { QtyStepper } from "@/components/cart/qty-stepper";
import { ProductThumb } from "@/components/product-thumb";
import { localizedName, unitLabel } from "@/lib/catalog/display";
import { formatEuros } from "@/lib/money";
import type { CustomerCatalogProduct } from "@/lib/supabase/public.types";

/**
 * ONE catalogue line: photo, what the product is, and the two things a customer
 * can do to it. Shared by every list of products a customer scrolls — the
 * catalogue's right pane and the search results — which is why it lives here and
 * not under one route.
 *
 * **The bug this shape exists to kill.** The row used to be a `flex-wrap` line
 * of four cells, and on a phone the name cell was `basis-full`: the name took
 * the whole width and the price, the stepper and the star wrapped underneath it
 * — until a name that could not be squeezed any further (a long Chinese title
 * has no spaces to break at) stopped the line from wrapping the way the CSS
 * assumed and rode straight over the `+`. The customer's screenshot showed the
 * title covering the control they were trying to press.
 *
 * A GRID cannot do that. The three columns below are declared once, in the
 * template, and the middle one is `minmax(0,1fr)` — the `0` is the load-bearing
 * half: without it a grid item's automatic minimum is its MIN-CONTENT width, so
 * an unbreakable title would push the track wider than its share and shove the
 * action column off the row. With it, the title's box can never exceed the space
 * the other two tracks left, and `line-clamp-2` caps what overflows vertically.
 *
 * ```text
 *   ┌───────┬─────────────────────────┬──────────────────────────┐
 *   │2.75rem│ minmax(0,1fr)           │ 8.75rem  (FIXED)         │
 *   │ thumb │ name (2 lines max)      │  [stepper slot] ␣ [★]    │
 *   │       │ codart · CAJA×24 (1 ln) │   6.25rem     4px 2.25rem│
 *   │       │ 12,00 €                 │                          │
 *   └───────┴─────────────────────────┴──────────────────────────┘
 * ```
 *
 * **Why the action column is a FIXED track and not `auto`.** The stepper inside
 * it grows from a lone `+` (32px) to `− n +` (100px) the moment the product is
 * in the cart. An `auto` track would resize on that press: every row's name
 * column would jump 68px narrower, re-wrapping titles down the whole list, and
 * the button under the customer's finger would move while they were pressing it.
 * The track is sized for the WIDE state and the stepper is right-aligned in it,
 * so the geometry is identical in both — which is also what keeps the stars in a
 * column down a 50-row page however many rows are already in the cart.
 *
 * The 8.75rem is the sum of what stands in it and nothing else: 6.25rem for the
 * stepper (see `STEPPER_SLOT`), a 4px gap, and the 2.25rem star. **The gap is
 * not decoration.** Flush against each other, the `+`'s right edge IS the star's
 * left edge, and a thumb aiming at `+` that lands 2px wide adds nothing to the
 * cart — it silently toggles a favourite instead. Two adjacent controls whose
 * outcomes have nothing to do with each other need a miss margin between them,
 * and 4px of dead pixels is the cheapest one available on a 375px row.
 *
 * The star is 36px rather than the 44px a full-width touch target would be: on a
 * phone the extra 8px would come out of the product name, which is the row's
 * whole point, and 36px still clears WCAG 2.2 AA's 24px target minimum.
 *
 * **The row owns its own insets and its own top rule** (`px-3 py-2.5 border-t`),
 * where it used to inherit both from the card the list was drawn on. There is no
 * card any more: the list is painted straight onto the white pane, so a row that
 * did not pad itself would sit against the pane's edge and the hairline between
 * two rows would stop short of it. Padding INSIDE the bordered box is also what
 * makes that rule full-bleed, as the design draws it.
 *
 * The 10px column gap is the design's, and on a phone it is not decoration
 * either: the two gaps are 20px of the ~74px the name column is left with once
 * the 88px rail, the thumb and the fixed action column have taken their share.
 */
const ROW =
  "grid grid-cols-[2.75rem_minmax(0,1fr)_8.75rem] items-center gap-x-2.5 border-t border-[#F4F0EC] px-3 py-2.5";

/**
 * The stepper's fixed footprint, right-aligned. 6.25rem = 100px, which is the
 * widest the stepper can ever be: a 32px `−`, a 2px gap, the quantity capped at
 * 32px by `max-w-8` in `STEPPER_QTY`, another 2px gap and a 32px `+` = 100px.
 * Sized from the control rather than guessed, so no quantity can make the
 * stepper overhang the track and reach back over the name.
 *
 * A row that cannot be ordered renders the slot EMPTY rather than dropping it:
 * the star column stays where it is, and so does everything below.
 */
const STEPPER_SLOT = "flex w-[6.25rem] shrink-0 justify-end";

export async function ProductRow({
  product,
  locale,
  isFavorite,
  showPrices,
}: {
  product: CustomerCatalogProduct;
  locale: Locale;
  isFavorite: boolean;
  /** The owner's `show_prices` setting, as the page read it once for the request. */
  showPrices: boolean;
}) {
  const t = await getTranslations("catalog");
  // The view projects the products PK and NOT NULL columns; the generated view
  // types widen every column to `| null`.
  const id = product.id as string;
  const name = localizedName(product.name, locale);
  // The price of ONE CAJA, computed in the view as `price_cents x
  // units_per_case` — exact integer multiplication, and the only money figure
  // this row knows. Quantities are cajas, so this is the number that belongs
  // beside them.
  //
  // It is null exactly when the tarifa price is (the factor is NOT NULL), which
  // is why it also answers "can this row be ordered": every price is NULL until
  // the owner's Wingest merge, so today an unpriced row renders as a disabled
  // button explaining why, and the moment a tarifa price lands the same row
  // becomes orderable with no code change.
  const caseCents = product.price_per_case_cents;
  const priced = caseCents != null;

  return (
    <li className={`${ROW} ${product.is_available ? "" : "opacity-45"}`}>
      <ProductThumb src={product.image_url} />

      <div className="min-w-0">
        {/* TWO LINES, then an ellipsis. Not `truncate`: at the width a phone can
            spare, one line of a Spanish name (25 characters at the median, 37 at
            the 90th percentile) is half a product. Two lines show the size and
            the flavour — the part that tells two tins apart — and the clamp is
            what stops a 57-character name from making one row as tall as three.

            `break-words` is what makes the clamp honest on a LATIN name.
            `line-clamp` only ever ellipsises a line-COUNT overflow: a word with
            no break opportunity in it — ESPECIALIDADES, ~12 characters, wider
            than the ~74px this column gets on a phone — is one line that
            overflows sideways, so the clamp has nothing to count and the word is
            cut mid-glyph with no ellipsis at all. Allowing the break puts the
            rest of the word on line two, where the clamp can do its job. Chinese
            never hit this (it breaks between any two characters), which is why
            the phone the bug was reported from never showed it. */}
        <p className="line-clamp-2 text-sm leading-[1.35] font-semibold break-words">
          {name}
        </p>

        <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted">
          {/* `1-002 · CAJA×24`: the factor is what turns the price below into an
              offer a restaurant can judge. It is silent at 1 — see `unitLabel`.
              One line, truncated: this is reference detail, and a second line of
              it would push the price out of a scanning customer's eye. */}
          <span className="truncate">
            {product.codart} · {unitLabel(product.unit, product.units_per_case)}
          </span>
          {/* Both badges keep their width — a truncated 断货 says nothing — so it
              is the codart that gives way on a narrow screen. */}
          {product.is_weighed && (
            <span className="shrink-0 rounded-md bg-amber-100 px-1.5 py-0.5 text-amber-800">
              {t("weighed")}
            </span>
          )}
          {!product.is_available && (
            <span className="shrink-0 rounded-md bg-gray-200 px-1.5 py-0.5 text-gray-600">
              {t("unavailable")}
            </span>
          )}
        </p>

        {/* The price sits UNDER the name, inside the text column, rather than in
            a column of its own: at 375px a fourth track would have come out of
            the name, and the amount belongs to the product, not to the button.
            The whole line goes when the owner has prices off — 价格待定 included.
            It is the price's placeholder, so leaving it behind would put a note
            ABOUT pricing on a page that is deliberately not talking about prices.
            Ordering is unaffected: the stepper is gated on `priced`, which the
            server resolved either way. */}
        {showPrices && (
          <p className="mt-1 font-num text-sm font-semibold tabular-nums">
            {caseCents != null ? (
              formatEuros(caseCents, locale)
            ) : (
              // A note, not a figure, and sized like one: at the price's own
              // 14px "Precio pendiente" is 106px wide, half again the column a
              // phone leaves this text — on every row, since every price is NULL
              // until the owner's Wingest merge. At 12px it is 94px, which still
              // wraps here but into the shortest shape it has, and it is the
              // size the meta line above uses for everything that is not money.
              <span className="text-xs font-normal text-muted">
                {t("noPrice")}
              </span>
            )}
          </p>
        )}
      </div>

      <div className="flex items-center justify-end gap-1">
        <div className={STEPPER_SLOT}>
          {/* Ordering gates on is_orderable (is_available AND
              is_current_variant): a row that cannot be ordered gets no control
              at all, rather than one that would fail. */}
          {product.is_orderable && (
            <QtyStepper
              productId={id}
              name={name}
              priced={priced}
              showPrices={showPrices}
            />
          )}
        </div>
        <form action={toggleFavorite} className="shrink-0">
          <input type="hidden" name="product_id" value={id} />
          <input type="hidden" name="locale" value={locale} />
          <input type="hidden" name="on" value={isFavorite ? "0" : "1"} />
          <button
            type="submit"
            aria-label={isFavorite ? t("favRemove") : t("favAdd")}
            // Amber, not brand: a starred product is a state of the row, and the
            // accent is spent on actions.
            className={`inline-flex size-9 items-center justify-center rounded-full text-lg transition-colors ${
              isFavorite ? "text-amber-500" : "text-muted/40 hover:text-muted"
            }`}
          >
            ★
          </button>
        </form>
      </div>
    </li>
  );
}
