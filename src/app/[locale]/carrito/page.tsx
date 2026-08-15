import type { Locale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { cookies } from "next/headers";
import Link from "next/link";
import { setCartQty } from "@/app/actions/cart";
import { submitOrder } from "@/app/actions/checkout";
import { requireCompanyUser } from "@/lib/auth/guards";
import { CART_COOKIE, parseCart } from "@/lib/cart";
import { localizedName } from "@/lib/catalog/display";
import { formatEuros, lineTotalCents } from "@/lib/money";
import {
  addDays,
  isOrderErrorDetail,
  isOrderErrorKey,
  madridDay,
} from "@/lib/orders";
import type { CustomerCatalogProduct } from "@/lib/supabase/public.types";
import { createServerSupabase } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/** How far ahead `create_order` accepts a delivery date (Madrid today..+60). */
const DELIVERY_WINDOW_DAYS = 60;

/** Exactly the columns this page renders, off the customer-safe priced view. */
type CartProduct = Pick<
  CustomerCatalogProduct,
  "id" | "codart" | "name" | "unit" | "is_weighed" | "is_orderable" | "price_cents"
>;

type CartRow = {
  productId: string;
  qty: number;
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
  searchParams: Promise<{ error?: string; detail?: string; cartError?: string }>;
}) {
  const { locale } = await params;
  const {
    error: rawError,
    detail: rawDetail,
    cartError: rawCartError,
  } = await searchParams;
  setRequestLocale(locale);
  await requireCompanyUser(locale);
  const t = await getTranslations("cart");
  // The badges and the price-pending wording are catalog vocabulary; reused
  // rather than duplicated into a second namespace.
  const tCatalog = await getTranslations("catalog");
  const tNav = await getTranslations("nav");

  // Both query strings are user-editable, so both are validated before they can
  // put a single character on the page.
  const errorText = rawError ?? "";
  const detailText = rawDetail ?? "";
  const error = isOrderErrorKey(errorText) ? errorText : undefined;
  const detail =
    error && isOrderErrorDetail(detailText) ? detailText : undefined;
  const cartError =
    rawCartError === "full" || rawCartError === "qty" ? rawCartError : null;

  // A page may READ the cart cookie; only the server actions write it.
  const cart = parseCart((await cookies()).get(CART_COOKIE)?.value);
  const ids = Object.keys(cart);

  const supabase = await createServerSupabase();
  let products: CartProduct[] = [];
  if (ids.length > 0) {
    // No is_current_variant filter, unlike the catalog: a line already in the
    // cart has to resolve so it can be shown and removed, even once the product
    // has stopped being orderable.
    const { data, error: queryError } = await supabase
      .from("products_priced")
      .select("id, codart, name, unit, is_weighed, is_orderable, price_cents")
      .in("id", ids);
    if (queryError) console.error("cart products query:", queryError);
    products = data ?? [];
  }

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
      const priceCents = product?.is_orderable ? product.price_cents : null;
      return {
        productId,
        qty: cart[productId],
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

  let subtotalCents = 0;
  let priceable = rows.length > 0;
  for (const row of rows) {
    if (row.totalCents == null) priceable = false;
    else subtotalCents += row.totalCents;
  }

  // Two different blockers with two different fixes: remove the line, or wait
  // for the price. The same sentence explains the banner and the dead button.
  const hasUnavailable = rows.some((row) => !row.product?.is_orderable);
  const hasPendingPrice = rows.some(
    (row) => row.product?.is_orderable && row.product.price_cents == null,
  );
  const blockedMessage = hasUnavailable
    ? t("errors.PRODUCT_UNAVAILABLE")
    : hasPendingPrice
      ? t("pendingPrices")
      : null;

  const today = madridDay(new Date());
  const cartHref = `/${locale}/carrito`;
  // Minted per render, and the page is force-dynamic: resubmitting the SAME
  // rendered form carries the SAME token, so create_order returns the order it
  // already made rather than a duplicate.
  const clientToken = crypto.randomUUID();

  return (
    <main className="mx-auto max-w-3xl p-4 sm:p-6">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-bold">{t("title")}</h1>
        <Link className="text-sm underline" href={`/${locale}/catalogo`}>
          ← {tNav("catalog")}
        </Link>
      </div>

      {error && (
        <p
          role="alert"
          className="mt-4 rounded bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {t(`errors.${error}`)}
          {detail && (
            <span className="ml-2 font-mono text-xs opacity-80">{detail}</span>
          )}
        </p>
      )}

      {cartError && (
        <p
          role="alert"
          className="mt-4 rounded bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {cartError === "full" ? t("full") : t("badQty")}
        </p>
      )}

      {rows.length === 0 ? (
        <p className="mt-10 text-center text-gray-400">{t("empty")}</p>
      ) : (
        <>
          <ul className="mt-4 divide-y">
            {rows.map((row) => {
              const name = localizedName(row.product?.name, locale);
              const orderable = row.product?.is_orderable === true;
              const weighed = row.product?.is_weighed === true;
              return (
                <li
                  key={row.productId}
                  className={`flex flex-wrap items-center gap-x-3 gap-y-2 py-3 ${
                    orderable ? "" : "opacity-45"
                  }`}
                >
                  <div className="min-w-0 flex-1 basis-full sm:basis-0">
                    {/* Only the name truncates. The badges sit on the wrapping
                        meta line below, where a long name can never clip them
                        out of view on a narrow phone. */}
                    <p className="truncate font-medium">{name || "—"}</p>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-gray-500">
                      <span>
                        {row.product
                          ? `${row.product.codart} · ${row.product.unit}`
                          : row.productId}
                      </span>
                      {weighed && (
                        <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-800">
                          {tCatalog("weighed")}
                        </span>
                      )}
                      {!orderable && (
                        <span className="rounded bg-gray-200 px-1.5 py-0.5 text-gray-600">
                          {tCatalog("unavailable")}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* A line that can never be ordered gets no quantity box, only
                      the way out — editing it would be busywork. */}
                  {orderable && (
                    <form
                      action={setCartQty}
                      className="flex items-center gap-1"
                    >
                      <input
                        type="hidden"
                        name="product_id"
                        value={row.productId}
                      />
                      <input type="hidden" name="locale" value={locale} />
                      <input type="hidden" name="back" value={cartHref} />
                      <input
                        type="number"
                        name="qty"
                        defaultValue={row.qty}
                        // Weighed goods are sold by fractional kilo; everything
                        // else is whole units, which is also what create_order
                        // enforces (BAD_QTY_STEP). Removing a line is the ×
                        // button's job, so neither minimum reaches 0.
                        step={weighed ? 0.001 : 1}
                        min={weighed ? 0.001 : 1}
                        inputMode="decimal"
                        // One "Cantidad" per row would be useless to a screen
                        // reader, so the name goes in the label — unless the
                        // product carries none in either language.
                        aria-label={name ? t("qtyFor", { name }) : t("qty")}
                        className="w-24 rounded border px-2 py-1 text-right"
                      />
                      <button
                        type="submit"
                        className="rounded border px-2 py-1 text-xs"
                      >
                        {t("update")}
                      </button>
                    </form>
                  )}

                  <p className="w-28 text-right text-sm font-semibold">
                    {/* Named for screen readers, silent on screen: a bare amount
                        in a row does not say whether it is the unit price or
                        the line. */}
                    <span className="sr-only">{t("lineTotal")}: </span>
                    {row.totalCents != null ? (
                      formatEuros(row.totalCents, locale)
                    ) : (
                      <span className="font-normal text-gray-400">
                        {tCatalog("noPrice")}
                      </span>
                    )}
                  </p>

                  <form action={setCartQty}>
                    <input
                      type="hidden"
                      name="product_id"
                      value={row.productId}
                    />
                    <input type="hidden" name="locale" value={locale} />
                    <input type="hidden" name="back" value={cartHref} />
                    {/* setCartQty takes an absolute quantity, and 0 removes. */}
                    <input type="hidden" name="qty" value="0" />
                    <button
                      type="submit"
                      aria-label={name ? t("removeFor", { name }) : t("remove")}
                      className="px-2 text-lg leading-none text-gray-400"
                    >
                      ×
                    </button>
                  </form>
                </li>
              );
            })}
          </ul>

          <div className="mt-4 flex items-center justify-between border-t pt-4">
            <span className="text-sm text-gray-600">{t("subtotal")}</span>
            <span className="text-lg font-semibold">
              {priceable ? (
                formatEuros(subtotalCents, locale)
              ) : (
                <span className="font-normal text-gray-400">—</span>
              )}
            </span>
          </div>

          {blockedMessage && (
            <p
              role="status"
              className="mt-4 rounded bg-amber-50 px-3 py-2 text-sm text-amber-800"
            >
              {blockedMessage}
            </p>
          )}

          {/* No line inputs: submitOrder reads them from the httpOnly cookie, so
              nothing here can add a product or set a price. */}
          <form action={submitOrder} className="mt-6 border-t pt-6">
            <input type="hidden" name="locale" value={locale} />
            <input type="hidden" name="client_token" value={clientToken} />
            <h2 className="text-lg font-semibold">{t("checkout")}</h2>

            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <div>
                <label
                  htmlFor="delivery_date"
                  className="block text-sm text-gray-600"
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
                  className="mt-1 w-full rounded border px-3 py-2"
                />
              </div>
              <div>
                <label htmlFor="note" className="block text-sm text-gray-600">
                  {t("note")}
                </label>
                <textarea
                  id="note"
                  name="note"
                  rows={2}
                  // create_order rejects anything longer (NOTE_TOO_LONG).
                  maxLength={2000}
                  placeholder={t("notePlaceholder")}
                  className="mt-1 w-full rounded border px-3 py-2"
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={!priceable}
              title={blockedMessage ?? undefined}
              className="mt-4 rounded bg-black px-4 py-2 text-white disabled:cursor-not-allowed disabled:opacity-40"
            >
              {t("submitOrder")}
            </button>
          </form>
        </>
      )}
    </main>
  );
}
