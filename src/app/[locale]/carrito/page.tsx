import type { Locale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { cookies } from "next/headers";
import { submitOrder } from "@/app/actions/checkout";
import { AppShell } from "@/components/app-shell";
import {
  CartLine,
  CartQtyInput,
  CartRemoveButton,
  CartSubtotal,
} from "@/components/cart/cart-line";
import { ProductThumb } from "@/components/product-thumb";
import { BTN_PRIMARY, CARD, FIELD } from "@/components/ui";
import { beginCompanyUser, finishCompanyUser } from "@/lib/auth/guards";
import { CART_COOKIE, parseCart } from "@/lib/cart";
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
  // them, so the phone's bar could total the cart; it hides itself here instead,
  // because the subtotal is already in the layout below.
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
      <h1 className="mt-8 text-2xl font-bold tracking-tight">{t("title")}</h1>

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
        <p className={`${CARD} mt-4 p-10 text-center text-muted`}>
          {t("empty")}
        </p>
      ) : (
        <>
          <ul className={`${CARD} mt-4 divide-y divide-border px-4 sm:px-5`}>
            {rows.map((row) => {
              const name = localizedName(row.product?.name, locale);
              const orderable = row.product?.is_orderable === true;
              const weighed = row.product?.is_weighed === true;
              return (
                // The <li> is a client leaf so the row can leave the list the
                // moment its quantity reaches 0 — the one place where waiting
                // for the cookie's render would look like the × did nothing.
                <CartLine
                  key={row.productId}
                  productId={row.productId}
                  className={`flex flex-wrap items-center gap-x-3 gap-y-2 py-3 ${
                    orderable ? "" : "opacity-45"
                  }`}
                >
                  {/* Thumbnail inside the name cell, as on the catalogue: the
                      cell is `basis-full` on a phone, so a sibling of it would
                      be pushed onto a line of its own. A line whose product has
                      vanished has no photo either, and falls to the empty box. */}
                  <div className="flex min-w-0 flex-1 basis-full items-center gap-3 sm:basis-0">
                    <ProductThumb src={row.product?.image_url} />
                    <div className="min-w-0 flex-1">
                      {/* Only the name truncates. The badges sit on the wrapping
                          meta line below, where a long name can never clip them
                          out of view on a narrow phone. */}
                      <p className="truncate font-medium">{name || "—"}</p>
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
                    </div>
                  </div>

                  {/* A line that can never be ordered gets no quantity box, only
                      the way out — editing it would be busywork. */}
                  {orderable && (
                    <CartQtyInput
                      productId={row.productId}
                      name={name}
                      weighed={weighed}
                    />
                  )}

                  {/* Label and amount are ONE cell, so hiding prices takes the
                      screen-reader "金额:" with the figure — a lone label read
                      out with nothing after it is worse than no cell at all. */}
                  {showPrices && (
                    <p className="w-28 text-right text-sm font-semibold">
                      {/* Named for screen readers, silent on screen: a bare
                          amount in a row does not say whether it is the unit
                          price or the line. */}
                      <span className="sr-only">{t("lineTotal")}: </span>
                      {row.totalCents != null ? (
                        formatEuros(row.totalCents, locale)
                      ) : (
                        <span className="font-normal text-muted">
                          {tCatalog("noPrice")}
                        </span>
                      )}
                    </p>
                  )}

                  <CartRemoveButton productId={row.productId} name={name} />
                </CartLine>
              );
            })}
          </ul>

          {/* The whole row, label included. `CartSubtotal` is a client leaf that
              would otherwise render a dash under 小计 — an amount the customer
              is not meant to be shown at all, dressed as one we failed to
              compute. */}
          {showPrices && (
            <div className="mt-4 flex items-center justify-between px-4 sm:px-5">
              <span className="text-sm text-muted">{t("subtotal")}</span>
              <CartSubtotal locale={locale} />
            </div>
          )}

          {blockedMessage && (
            <p
              role="status"
              className="mt-4 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800"
            >
              {blockedMessage}
            </p>
          )}

          {/* No line inputs: submitOrder reads them from the httpOnly cookie, so
              nothing here can add a product or set a price. */}
          <form action={submitOrder} className={`${CARD} mt-6 p-4 sm:p-5`}>
            <input type="hidden" name="locale" value={locale} />
            <input type="hidden" name="client_token" value={clientToken} />
            <h2 className="text-lg font-semibold">{t("checkout")}</h2>

            {/* With the date switch off the note is the only field left, so the
                two-column grid goes with the picker: a lone textarea stranded in
                the left half of a desktop card looks like something failed to
                render, and `submitOrder` refuses a posted date in that state
                anyway (a stale tab is the only thing that can send one). */}
            <div
              className={`mt-4 grid gap-4 ${showDeliveryDate ? "sm:grid-cols-2" : ""}`}
            >
              {showDeliveryDate && (
                <div>
                  <label
                    htmlFor="delivery_date"
                    className="block text-sm text-muted"
                  >
                    {t("deliveryDate")}
                  </label>
                  <input
                    id="delivery_date"
                    type="date"
                    name="delivery_date"
                    // The same window create_order enforces, computed on Madrid's
                    // calendar rather than the browser's.
                    min={today}
                    max={addDays(today, DELIVERY_WINDOW_DAYS)}
                    className={`mt-1 w-full ${FIELD}`}
                  />
                </div>
              )}
              <div>
                <label htmlFor="note" className="block text-sm text-muted">
                  {t("note")}
                </label>
                <textarea
                  id="note"
                  name="note"
                  rows={2}
                  // create_order rejects anything longer (NOTE_TOO_LONG).
                  maxLength={2000}
                  placeholder={t("notePlaceholder")}
                  className={`mt-1 w-full ${FIELD}`}
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={!priceable}
              title={blockedMessage ?? undefined}
              className={`mt-4 ${BTN_PRIMARY}`}
            >
              {t("submitOrder")}
            </button>
          </form>
        </>
      )}
    </AppShell>
  );
}
