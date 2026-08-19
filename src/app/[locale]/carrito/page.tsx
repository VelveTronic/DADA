import type { Locale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { cookies } from "next/headers";
import Link from "next/link";
import { submitOrder } from "@/app/actions/checkout";
import { AppShell } from "@/components/app-shell";
import {
  CartLine,
  CartQtyInput,
  CartRemoveButton,
  CartSubtotal,
} from "@/components/cart/cart-line";
import { ClearCartButton } from "@/components/cart/clear-cart-button";
import { QtyStepper } from "@/components/cart/qty-stepper";
import { ProductThumb } from "@/components/product-thumb";
import { BTN_PRIMARY, CARD, FIELD } from "@/components/ui";
import { beginCompanyUser, finishCompanyUser } from "@/lib/auth/guards";
import { CART_COOKIE, cartUnits, parseCart } from "@/lib/cart";
import { localizedName, unitLabel } from "@/lib/catalog/display";
import { formatEuros, lineTotalCents } from "@/lib/money";
import {
  addDays,
  isOrderErrorDetail,
  isOrderErrorKey,
  madridDay,
} from "@/lib/orders";
import { perfRun } from "@/lib/perf";
import { getSetting } from "@/lib/settings";
import type { CustomerCatalogProduct } from "@/lib/supabase/public.types";

export const dynamic = "force-dynamic";

/** How far ahead `create_order` accepts a delivery date (Madrid today..+60). */
const DELIVERY_WINDOW_DAYS = 60;

/** Exactly the columns this page renders, off the customer-safe priced view. */
type CartProduct = Pick<
  CustomerCatalogProduct,
  | "id"
  | "codart"
  | "name"
  | "unit"
  | "units_per_case"
  | "is_weighed"
  | "is_orderable"
  | "price_per_case_cents"
  | "image_url"
>;

type CartRow = {
  productId: string;
  /** Null when the product no longer exists at all — the cookie outlived it. */
  product: CartProduct | null;
  /** Null whenever this line cannot be priced, for whichever of the two reasons. */
  totalCents: number | null;
};

export default async function CartPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: Locale }>;
  searchParams: Promise<{ error?: string; detail?: string }>;
}) {
  const { locale } = await params;
  const { error: rawError, detail: rawDetail } = await searchParams;
  setRequestLocale(locale);
  const perf = perfRun(`/${locale}/carrito`);
  const { supabase, pendingUser } = await beginCompanyUser(locale);
  const t = await getTranslations("cart");
  // The badges and the price-pending wording are catalog vocabulary; reused
  // rather than duplicated into a second namespace.
  const tCatalog = await getTranslations("catalog");

  // Both query strings are user-editable, so both are validated before they can
  // put a single character on the page.
  const errorText = rawError ?? "";
  const detailText = rawDetail ?? "";
  const error = isOrderErrorKey(errorText) ? errorText : undefined;
  const detail =
    error && isOrderErrorDetail(detailText) ? detailText : undefined;

  // A page may READ the cart cookie; only the server actions write it.
  const cart = parseCart((await cookies()).get(CART_COOKIE)?.value);
  const ids = Object.keys(cart);

  // ONE round: the restaurant's profile row (already in flight from the guard),
  // the cart's lines and the owner's two switches. None of them needs anything
  // from the others — the line ids come from the cookie above — so a cart page
  // costs one trip to the database however full it is. An empty cart has no
  // products query to make, so that half resolves to null. The settings pair
  // shares one `perf.step` for the same reason the owner page's does: the line
  // reports what the switches cost, not one timing per switch.
  const [portalUser, productResult, [showPrices, showDeliveryDate]] = await Promise.all([
    finishCompanyUser(pendingUser, locale),
    // No is_current_variant filter, unlike the catalog: a line already in the
    // cart has to resolve so it can be shown and removed, even once the product
    // has stopped being orderable.
    ids.length > 0
      ? perf.step(
          "products",
          supabase
            .from("products_priced")
            // `price_per_case_cents` and not `price_cents`: quantities in this
            // cart are CAJAS, so the only unit price that may multiply them is
            // the one the view already computed per caja.
            //
            // One string literal, never a concatenation: supabase-js types the
            // row from the literal, and `"a, " + "b"` widens to `string`.
            .select(
              "id, codart, name, unit, units_per_case, is_weighed, is_orderable, price_per_case_cents, image_url",
            )
            .in("id", ids),
        )
      : Promise.resolve(null),
    perf.step(
      "settings",
      Promise.all([
        getSetting(supabase, "show_prices"),
        getSetting(supabase, "show_delivery_date"),
      ]),
    ),
  ]);
  perf.end();
  if (productResult?.error)
    console.error("cart products query:", productResult.error);
  const products: CartProduct[] = productResult?.data ?? [];

  // The view projects the products PK, but generated view types widen every
  // column to `| null`; keying off the narrowed value avoids a cast.
  const byId = new Map<string, CartProduct>();
  for (const product of products) {
    if (product.id) byId.set(product.id, product);
  }

  const rows: CartRow[] = ids
    .map((productId) => {
      const product = byId.get(productId) ?? null;
      // A vanished or paused product has no price to charge, whatever the view
      // still says: both block the order, and both are fixed by removing the line.
      const priceCents = product?.is_orderable
        ? product.price_per_case_cents
        : null;
      return {
        productId,
        product,
        totalCents:
          priceCents == null ? null : lineTotalCents(cart[productId], priceCents),
      };
    })
    .sort((a, b) => {
      // A vanished product has no codart to sort by, so those lines sink to the
      // bottom, next to the banner that tells the customer to remove them.
      if (!a.product !== !b.product) return a.product ? -1 : 1;
      return (a.product?.codart ?? "").localeCompare(b.product?.codart ?? "");
    });

  // The SERVER's answer, and now only for the submit button and the banner
  // beside it. The subtotal on screen comes from the provider (`CartSubtotal`),
  // so it cannot lag an optimistically removed row — but whether checkout is
  // OPEN is the one thing that must not move optimistically: a button enabled
  // ahead of the cookie is a button that submits an order the server is about
  // to refuse. It settles a beat later, conservatively, which is the right way
  // round.
  const priceable =
    rows.length > 0 && rows.every((row) => row.totalCents != null);

  // Two different blockers with two different fixes: remove the line, or wait
  // for the price. The same sentence explains the banner and the dead button.
  const hasUnavailable = rows.some((row) => !row.product?.is_orderable);
  const hasPendingPrice = rows.some(
    (row) => row.product?.is_orderable && row.product.price_per_case_cents == null,
  );
  // …and with the owner's switch off, the price one is explained WITHOUT the
  // word. This page has just hidden every amount on it, so "some prices are
  // pending" would be the only mention of pricing left — on the banner AND in
  // the dead submit button's tooltip, which is the same sentence twice. The
  // price-free wording says the part the customer can act on: these lines cannot
  // be ordered yet, and it is not something they did.
  const blockedMessage = hasUnavailable
    ? t("errors.PRODUCT_UNAVAILABLE")
    : hasPendingPrice
      ? showPrices
        ? t("pendingPrices")
        : t("pendingUnavailable")
      : null;

  // Every line this render could price, for the provider — per CAJA, which is
  // what the quantity beside it counts. On this page that is normally all of
  // them, so the shell's floating demand bar could total the cart; it hides
  // itself here instead (`cart/cart-bar.tsx`), because this page's own submit
  // bar is at the bottom of the same screen and says the same figures.
  //
  // With the owner's switch OFF the map is not built at all: the subtotal row
  // and every line amount are omitted server-side, so the only consumer left
  // (`CartSubtotal`) never renders, and there is no reason to ship the tarifa
  // into the browser to be discarded. Same rule as the catalogue's.
  const cartPrices: Record<string, number> | undefined = showPrices ? {} : undefined;
  if (cartPrices) {
    for (const row of rows) {
      if (row.product?.is_orderable && row.product.price_per_case_cents != null) {
        cartPrices[row.productId] = row.product.price_per_case_cents;
      }
    }
  }

  // The submit bar's two figures, and both are the SERVER's — `rows.length` is
  // the cookie's line count and `cartUnits` adds the same cookie's quantities up
  // (rounded to the cookie's own three decimals, so a weighed 2 + 0.75 reads
  // 2.75 and never 2.7500000000000004).
  //
  // Deliberately not the provider's optimistic mirror, which the rows and the
  // subtotal beside them DO use. The button between them is server truth — it is
  // enabled only once the cookie the server read can actually be ordered (see
  // `priceable` above) — so the count next to it is read as a description of
  // what that button will submit. Two figures that ran ahead of it would say a
  // different cart is about to be sent than the one that is. The cost is one
  // beat of lag after a removal: the row vanishes at once, the figures settle
  // when the cookie's render lands, which is the same beat the button takes.
  const units = cartUnits(cart);

  const today = madridDay(new Date());
  // Minted per render, and the page is force-dynamic: resubmitting the SAME
  // rendered form carries the SAME token, so create_order returns the order it
  // already made rather than a duplicate.
  const clientToken = crypto.randomUUID();

  return (
    <AppShell
      locale={locale}
      user={{ name: portalUser.display_name ?? portalUser.companies.name }}
      cartPrices={cartPrices}
      showPrices={showPrices}
    >
      {/* The screen's own title row, and on a phone its only way OUT: the tab
          bar hides itself on `/carrito` (`tab-bar.tsx` — that bottom edge
          belongs to 提交需求单), so without this link a customer who opened the
          demand list has nothing but the browser's own back gesture to leave it
          with. The chevron is a 44px target with the glyph centred in it, pulled
          back into the page gutter by `-ml-2.5` so the mark itself lines up with
          the cards below rather than the box around it. */}
      <div className="flex items-center gap-1 pt-3">
        <Link
          href={`/${locale}/catalogo`}
          aria-label={t("backToCatalog")}
          className="-ml-2.5 flex size-11 shrink-0 items-center justify-center text-2xl leading-none text-ink-soft transition-colors hover:text-brand-ink"
        >
          ‹
        </Link>
        <h1 className="min-w-0 truncate text-lg font-bold">{t("title")}</h1>
        {/* Renders nothing at all on an empty cart, which is why the row needs
            no placeholder beside the title. */}
        <ClearCartButton locale={locale} />
      </div>

      {error && (
        <p
          role="alert"
          className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {t(`errors.${error}`)}
          {detail && (
            <span className="ml-2 font-mono text-xs opacity-80">{detail}</span>
          )}
        </p>
      )}

      {rows.length === 0 ? (
        // No submit bar under this one: there is nothing to submit, and a dead
        // red button across the bottom of the screen is worse than no button.
        // The way on is the only control here.
        <div className={`${CARD} mt-4 p-10 text-center`}>
          <p className="text-muted">{t("empty")}</p>
          <Link
            href={`/${locale}/catalogo`}
            className={`mt-5 inline-flex h-11 items-center ${BTN_PRIMARY}`}
          >
            {t("goShop")}
          </Link>
        </div>
      ) : (
        <>
          {/* CLEARANCE for the fixed bar below, and the whole of it — this page
              reserves the bar's own height rather than leaning on the shell's
              `<main>` inset, which is the TAB BAR's and is paid on every
              customer page including the ones with no bar at all (and this route
              is precisely where the tab bar is not drawn).

              The bar measures, from the glass up: 1px of hairline + 12px of
              `pt-3` + the 48px submit button, which is the tallest thing in it
              (the count column is a 28px line over a 13px one = 41px) + its
              bottom padding, `max(0.875rem, env(safe-area-inset-bottom))`. That
              is 61 + max(14, S), so 75px on a phone with no home indicator and
              95px on one with S = 34. `pb-28` is 112px, which clears the taller
              of the two by 17px — and the shell's own 72 + S underneath it is
              margin on top of that, not the reservation. */}
          <div className="pb-28">
            <ul className={`${CARD} mt-4 divide-y divide-border px-4`}>
              {rows.map((row) => {
                const name = localizedName(row.product?.name, locale);
                const orderable = row.product?.is_orderable === true;
                const weighed = row.product?.is_weighed === true;
                // The `+` is gated on a price the same way the catalogue's is,
                // and for the same reason: a line whose tarifa price has not
                // landed cannot be ordered, so it must not be made bigger.
                const priced = row.product?.price_per_case_cents != null;
                return (
                  // The <li> is a client leaf so the row can leave the list the
                  // moment its quantity reaches 0 — the one place where waiting
                  // for the cookie's render would look like the × did nothing.
                  //
                  // The catalogue's grid, not a `flex-wrap` line: three declared
                  // tracks, the middle one `minmax(0,1fr)` so an unbreakable
                  // name can never push the action column off the row. See the
                  // long note on `ROW` in `product-row.tsx` — this is the same
                  // shape at this page's own measurements, and 254px is what the
                  // name and the controls divide between them on a 390px phone
                  // (390 − 32 page − 32 card − 48 thumb − 24 of column gaps).
                  <CartLine
                    key={row.productId}
                    productId={row.productId}
                    className={`grid grid-cols-[3rem_minmax(0,1fr)_auto] items-center gap-x-3 py-2.5 ${
                      orderable ? "" : "opacity-45"
                    }`}
                  >
                    <ProductThumb src={row.product?.image_url} />

                    <div className="min-w-0">
                      {/* Two lines then an ellipsis, and `break-words` so the
                          clamp is honest on a Spanish name that has no break
                          opportunity in it — both exactly as the catalogue row
                          does it, because this is the same product in the same
                          list. */}
                      <p className="line-clamp-2 text-sm leading-[1.35] font-semibold break-words">
                        {name || "—"}
                      </p>
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
                        {/* A vanished product has no codart to show and its uuid
                            means nothing to a restaurant, so the line says what
                            the customer needs to know instead. The remove button
                            still carries the id, which is all that has to travel. */}
                        <span>
                          {row.product
                            ? `${row.product.codart} · ${unitLabel(
                                row.product.unit,
                                row.product.units_per_case,
                              )}`
                            : tCatalog("unavailable")}
                        </span>
                        {weighed && (
                          <span className="rounded-md bg-amber-100 px-1.5 py-0.5 text-amber-800">
                            {tCatalog("weighed")}
                          </span>
                        )}
                        {/* …which is also why the badge is for PAUSED products
                            only: on a vanished line it would just say it twice. */}
                        {!orderable && row.product && (
                          <span className="rounded-md bg-gray-200 px-1.5 py-0.5 text-gray-600">
                            {tCatalog("unavailable")}
                          </span>
                        )}
                      </div>

                      {/* The amount sits UNDER the name inside the text column,
                          where the catalogue puts its price: a fourth track
                          would come out of the name, and this figure belongs to
                          the product rather than to the buttons. Label and
                          amount are ONE cell, so hiding prices takes the
                          screen-reader "金额:" with the figure — a lone label
                          read out with nothing after it is worse than no cell at
                          all. */}
                      {showPrices && (
                        <p className="mt-1 font-num text-sm font-semibold tabular-nums">
                          {/* Named for screen readers, silent on screen: a bare
                              amount in a row does not say whether it is the unit
                              price or the line. */}
                          <span className="sr-only">{t("lineTotal")}: </span>
                          {row.totalCents != null ? (
                            formatEuros(row.totalCents, locale)
                          ) : (
                            <span className="text-xs font-normal text-muted">
                              {tCatalog("noPrice")}
                            </span>
                          )}
                        </p>
                      )}
                    </div>

                    {/* The action column. A line that can never be ordered gets
                        no quantity control at all, only the way out — editing it
                        would be busywork.

                        WHICH control is the one thing this page still decides
                        for itself: whole-unit lines get the catalogue's `− n +`,
                        so the same product is edited the same way on both
                        screens, and WEIGHED lines keep the typed box, because a
                        stepper cannot express 2.75 kg. Both are 96px wide (the
                        box stacks its 更新 underneath on a phone — see
                        `cart-line.tsx`), so the name column is the same width on
                        every row of the list. */}
                    <div className="flex items-center gap-1">
                      {orderable &&
                        (weighed ? (
                          <CartQtyInput
                            productId={row.productId}
                            name={name}
                            weighed
                          />
                        ) : (
                          <QtyStepper
                            productId={row.productId}
                            name={name}
                            priced={priced}
                            showPrices={showPrices}
                          />
                        ))}
                      <CartRemoveButton productId={row.productId} name={name} />
                    </div>
                  </CartLine>
                );
              })}
            </ul>

            {/* Back to the goods, attached to the foot of the list it adds to:
                a dashed outline rather than a second filled button, because the
                one filled control on this screen is 提交需求单 and a demand list
                that is missing an item is fixed by going back, not by pressing
                something red. */}
            <Link
              href={`/${locale}/catalogo`}
              className="mt-3 flex h-11 items-center justify-center gap-1 rounded-card border border-dashed border-border-strong text-sm font-semibold text-brand-ink"
            >
              {/* The `+` is drawn, not translated: it is the same mark the
                  catalogue's add button carries, and a screen reader that read
                  it out would announce a plus sign in front of a sentence that
                  already says what the link does. */}
              <span aria-hidden>+</span>
              {t("keepAdding")}
            </Link>

            {blockedMessage && (
              <p
                role="status"
                className="mt-4 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800"
              >
                {blockedMessage}
              </p>
            )}

            {/* No line inputs: submitOrder reads them from the httpOnly cookie,
                so nothing here can add a product or set a price.

                The form's SUBMIT BUTTON is not in it — it is in the fixed bar at
                the bottom of the screen, joined back by `form="checkout-form"`.
                That is the whole reason this element carries an id. */}
            <form
              id="checkout-form"
              action={submitOrder}
              className="mt-5 flex flex-col gap-2"
            >
              <input type="hidden" name="locale" value={locale} />
              <input type="hidden" name="client_token" value={clientToken} />

              {/* Above the note, and gone entirely when the owner's switch is
                  off — `submitOrder` re-reads that switch on the POST and
                  refuses a date posted in that state anyway (a stale tab is the
                  only thing that can send one). */}
              {showDeliveryDate && (
                <>
                  <label
                    htmlFor="delivery_date"
                    className="text-[12.5px] font-semibold text-ink-soft"
                  >
                    {t("deliveryDate")}
                  </label>
                  <input
                    id="delivery_date"
                    type="date"
                    name="delivery_date"
                    // The same window create_order enforces, computed on
                    // Madrid's calendar rather than the browser's.
                    min={today}
                    max={addDays(today, DELIVERY_WINDOW_DAYS)}
                    className={`mb-2 w-full ${FIELD}`}
                  />
                </>
              )}

              <label
                htmlFor="note"
                className="text-[12.5px] font-semibold text-ink-soft"
              >
                {t("note")}
              </label>
              <textarea
                id="note"
                name="note"
                // create_order rejects anything longer (NOTE_TOO_LONG).
                maxLength={2000}
                placeholder={t("notePlaceholder")}
                // Fixed height and no drag handle: the design draws one box, and
                // a corner the customer can pull the layout around with on a
                // phone is not worth the two lines it would buy them.
                className={`h-[72px] resize-none ${FIELD} w-full text-[12.5px]`}
              />
            </form>

            {/* What happens after the press, said before it. Neither row is a
                control — this is the fine print of a demand list: the prices are
                the wholesaler's to confirm, and the van goes to the shop on the
                account. The mockup's third row (结算方式 月结) is deliberately
                absent: no payment-terms data exists anywhere in this schema, and
                a hard-coded "monthly account" would be a promise the portal
                cannot keep. */}
            <dl className="mt-4 flex flex-col gap-2 rounded-[10px] bg-surface-dim p-3.5 text-xs">
              <div className="flex justify-between gap-3">
                <dt className="shrink-0 text-muted">{t("methodLabel")}</dt>
                <dd className="text-right text-ink">{t("methodValue")}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="shrink-0 text-muted">{t("storeLabel")}</dt>
                {/* The company, not `display_name`: the shop the van unloads at,
                    which is not always the person who signed in. */}
                <dd className="truncate text-ink">
                  {portalUser.companies.name}
                </dd>
              </div>
            </dl>
          </div>

          {/* THE SUBMIT BAR. Fixed to the bottom of the screen for the whole
              length of the list, because on a phone the press that ends this
              screen must never be something the customer has to scroll to find —
              and it can take that edge outright, since the tab bar stands down
              on this route (`tab-bar.tsx`).

              `max(0.875rem, env(safe-area-inset-bottom))` is a FLOOR here rather
              than the sum the rest of the portal's bottom furniture uses: this
              bar is flush with the glass, so on a notched phone the 34px inset
              already puts more air under the button than the design's 14px, and
              adding the two would only push the button up off the edge it is
              anchored to. Every clearance above is written against the same
              expression. */}
          <div className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-surface px-4 pt-3 pb-[max(0.875rem,env(safe-area-inset-bottom))]">
            <div className="mx-auto flex max-w-5xl items-center justify-between gap-3">
              <div className="min-w-0">
                {/* Both figures are the server's — see the note where `units` is
                    computed. `<n>` is a TAG rather than a value because only a
                    tag can carry markup through a translation, and the count and
                    its unit have to stay in one sentence for a translator (the
                    Spanish one is a plural). */}
                <p className="truncate text-xs text-muted">
                  {t.rich("kindsCount", {
                    lines: rows.length,
                    n: (chunks) => (
                      <b className="font-num text-lg font-bold tabular-nums">
                        {chunks}
                      </b>
                    ),
                  })}
                </p>
                {/* The mockup paints this line in the design's faintest grey,
                    and this is one of the places the repo does not follow it.
                    `text-faint` is #A8A099, 2.58:1 on the white bar, and
                    `globals.css` licenses that token for placeholders and for
                    text that repeats what a label already said — neither of
                    which this line is any more. The subtotal row is GONE from
                    this page, so the amount at the end of it is the only place
                    the cart's money is written, and 合计 N 件 is the only place
                    the units are. `text-muted` is the same warm grey a shade
                    darker (5.57:1 on white) and clears AA. Same call as the tab
                    bar's labels and the /cuenta card. */}
                <p className="truncate text-[11px] text-muted">
                  {t("unitsTotal", { n: units })}
                  {" · "}
                  {showPrices ? (
                    <>
                      {/* The visible 小计 label went with the subtotal row this
                          bar replaced, so it is said here for screen readers
                          only: an amount at the end of a line of counts does not
                          say what it is the total of. */}
                      <span className="sr-only">{t("subtotal")}: </span>
                      <CartSubtotal locale={locale} />
                    </>
                  ) : (
                    // Not a blank where the money was: with the owner's switch
                    // off this portal is a demand list, and saying so is the
                    // point of the line.
                    t("noPayment")
                  )}
                </p>
              </div>

              {/* Outside its own form, and joined back to it by `form=`. The
                  DISABLED state is the server's answer and only the server's:
                  a button enabled ahead of the cookie is a button that submits
                  an order the server is about to refuse (see `priceable`). */}
              <button
                form="checkout-form"
                type="submit"
                disabled={!priceable}
                title={blockedMessage ?? undefined}
                className="h-12 max-w-[196px] flex-1 rounded-[11px] bg-brand text-[15px] font-semibold text-white shadow-[0_6px_16px_-6px_rgba(224,35,28,.6)] transition-colors hover:bg-brand-ink disabled:cursor-not-allowed disabled:opacity-40"
              >
                {t("submitOrder")}
              </button>
            </div>
          </div>
        </>
      )}
    </AppShell>
  );
}
