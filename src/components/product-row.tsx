import type { Locale } from "next-intl";
import { getTranslations } from "next-intl/server";
import { QtyStepper } from "@/components/cart/qty-stepper";
import { ProductThumb } from "@/components/product-thumb";
import { localizedName, unitLabel } from "@/lib/catalog/display";
import { formatEuros } from "@/lib/money";
import type { CustomerCatalogProduct } from "@/lib/supabase/public.types";

/**
 * ONE catalogue line: photo, what the product is, and the stepper that puts it
 * in the cart. Shared by every list of products a customer scrolls — the
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
 *   ┌───────┬────────────────────────────┬───────────────┐
 *   │2.75rem│ minmax(0,1fr)              │ 6rem FIXED    │
 *   │ thumb │ name (2 lines max)         │ [stepper slot]│
 *   │       │ codart · CAJA×24  [称重]   │   − n +  96px │
 *   │       │ 12,00 €                    │               │
 *   └───────┴────────────────────────────┴───────────────┘
 * ```
 *
 * **Why the action column is a FIXED track and not `auto`.** The stepper inside
 * it grows from a lone `+` (32px) to `− n +` (96px) the moment the product is in
 * the cart. An `auto` track would resize on that press: every row's name column
 * would jump 64px narrower, re-wrapping titles down the whole list, and the
 * button under the customer's finger would move while they were pressing it. The
 * track is sized for the WIDE state and the stepper is right-aligned in it, so
 * the geometry is identical in both — which is also what keeps the `+` squares
 * in a column down a 50-row page however many rows are already in the cart.
 *
 * **6rem is the stepper and nothing else** (96px — see `STEPPER_SLOT`). The
 * track used to be 8.75rem, because the favourite star stood beside the
 * stepper: 6.25rem + a 4px gap + the 2.25rem star = 140px. Measured on a 390px
 * phone, what the name was left with was three or four characters and an
 * ellipsis — and customers here identify goods BY NAME, so that was not a
 * product list. With the star out of the column the arithmetic ends
 * 390 − 92 rail (widened for five-character entries) − 24 row insets − 44 thumb
 * − 20 column gaps − 96 = 114px. The design mockup draws 120: the difference is
 * spent, deliberately, on the quantity box — 26px ellipsised a three-figure
 * order and 28px does not (see `STEPPER_QTY`) — and on the rail's fifth glyph.
 *
 * **The star is HIDDEN, owner's call (2026-08-19).** Its first retreat was from
 * the action column down onto the meta line, to buy the name that width back;
 * the owner then judged it noise beside the reference data and cut it from the
 * row entirely. The favourites FEATURE stays — rows starred before this still
 * fill the rail's 常购 entry and /cuenta's 常购清单 link, and `toggleFavorite`
 * is still a live server action — there is simply no toggle on the row. To
 * restore it, this file's git history has the form: a 36px negative-margin hit
 * box at the meta line's right edge.
 *
 * **The row owns its own insets and its own top rule** (`px-3 py-2.5 border-t`),
 * where it used to inherit both from the card the list was drawn on. There is no
 * card any more: the list is painted straight onto the white pane, so a row that
 * did not pad itself would sit against the pane's edge and the hairline between
 * two rows would stop short of it. Padding INSIDE the bordered box is also what
 * makes that rule full-bleed, as the design draws it.
 *
 * The 10px column gap is the design's, and on a phone it is not decoration
 * either: the two gaps are 20px of the 274px the row has inside its insets, and
 * they come out of the name like everything else here.
 */
const ROW =
  "grid grid-cols-[2.75rem_minmax(0,1fr)_6rem] items-center gap-x-2.5 border-t border-[#F4F0EC] px-3 py-2.5";

/**
 * The stepper's fixed footprint, right-aligned. 6rem = 96px, which is the
 * widest the stepper can ever be: a 32px `−`, a 2px gap, the quantity capped at
 * 28px by `max-w-7` in `STEPPER_QTY`, another 2px gap and a 32px `+` = 96px.
 * Sized from the control rather than guessed, so no quantity can make the
 * stepper overhang the track and reach back over the name.
 *
 * A row that cannot be ordered renders the slot EMPTY rather than dropping it:
 * the track still claims its 96px, so the name column keeps the same width on
 * every row of the list and the `+` squares stay in a column.
 */
const STEPPER_SLOT = "flex w-24 shrink-0 justify-end";

export async function ProductRow({
  product,
  locale,
  showPrices,
}: {
  product: CustomerCatalogProduct;
  locale: Locale;
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

            MEDIUM and ink-soft, not the mockup's 600 near-black. The owner
            reviewed a real list (2026-08-19) and read the bold titles as a wall
            — worst on the all-caps Spanish names, where 600 at 14px sets
            SOLID BLOCKS down the pane. 500 in Noto Sans (the body stack's new
            Latin face) with the deep-grey `--color-ink-soft` keeps the name the
            biggest thing on the row while the row stops shouting; hierarchy
            over the 12px muted meta line below survives on size and weight.

            `break-words` is what makes the clamp honest on a LATIN name.
            `line-clamp` only ever ellipsises a line-COUNT overflow: a word with
            no break opportunity in it — ESPECIALIDADES, 14 characters, about as
            wide as the 114px this column gets on a phone — is one line that
            overflows sideways, so the clamp has nothing to count and the word is
            cut mid-glyph with no ellipsis at all. Allowing the break puts the
            rest of the word on line two, where the clamp can do its job. Chinese
            never hit this (it breaks between any two characters), which is why
            the phone the bug was reported from never showed it. */}
        <p className="line-clamp-2 text-sm leading-[1.35] font-medium break-words text-ink-soft">
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
          {/* AT MOST ONE badge, and 断货 wins. A row that is both weighed and
              out of stock wants more than the meta line has: in Spanish,
              `Por peso` 60 + `Agotado` 57 + two 6px gaps ≈ 129px of content
              that cannot shrink (both badges are `shrink-0`, so only the
              codart can give) against the 114px the column gets on a phone.
              So 称重 renders only while the product is AVAILABLE: an
              out-of-stock row cannot be ordered, which makes how it is weighed
              moot on it, while 断货 is the whole reason it looks the way it
              does. Badges keep their width either way — a truncated 断货 says
              nothing — so it is the codart that gives way on a narrow screen. */}
          {product.is_available && product.is_weighed && (
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
              // A note, not a figure, and sized like one. At the price's own
              // 14px semibold Archivo, "Precio pendiente" measures 109px
              // against the 114px this column now gets — it clears the width
              // by 5px, and it is on EVERY row until the owner's Wingest
              // merge lands a tarifa, so the margin is worth having rather
              // than spending. At 12px it is 90px, which is the same one line
              // with room around it, and 12px is already the size the meta
              // line above uses for everything that is not money.
              <span className="text-xs font-normal text-muted">
                {t("noPrice")}
              </span>
            )}
          </p>
        )}
      </div>

      <div className={STEPPER_SLOT}>
        {/* Ordering gates on is_orderable (is_available AND is_current_variant):
            a row that cannot be ordered gets no control at all, rather than one
            that would fail. */}
        {product.is_orderable && (
          <QtyStepper
            productId={id}
            name={name}
            priced={priced}
            showPrices={showPrices}
          />
        )}
      </div>
    </li>
  );
}
