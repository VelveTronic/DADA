import type { Locale } from "next-intl";
import { getTranslations } from "next-intl/server";
import Image from "next/image";
import { QtyStepper } from "@/components/cart/qty-stepper";
import { localizedName, unitLabel } from "@/lib/catalog/display";
import { formatEuros } from "@/lib/money";
import type { CustomerCatalogProduct } from "@/lib/supabase/public.types";

/**
 * The catalogue's compact presentation: two larger product photos per row.
 * The existing DADA stepper is layered over the photo so the primary action
 * stays close to the product while keeping the card's text uncluttered.
 */
export async function ProductGrid({
  products,
  locale,
  showPrices,
}: {
  products: CustomerCatalogProduct[];
  locale: Locale;
  showPrices: boolean;
}) {
  const t = await getTranslations("catalog");

  return (
    <ul className="grid grid-cols-2 gap-x-2 gap-y-6 px-2 pb-2">
      {products.map((product) => {
        const id = product.id as string;
        const name = localizedName(product.name, locale);
        const caseCents = product.price_per_case_cents;
        const priced = caseCents != null;

        return (
          <li
            key={id}
            className={`min-w-0 ${product.is_available ? "" : "opacity-45"}`}
          >
            {/* `isolate` keeps the stepper's `z-10` INSIDE this card: without
                it the card is `relative` but not a stacking context, so the
                overlay competed with the pane's sticky header (also z-10) in
                the page context and — being later in the DOM — painted on top
                of it while scrolling (owner, 2026-08-21). Isolated, the whole
                card flattens to one layer under the header, and the z-10 keeps
                meaning what it meant: above the photo. */}
            <div className="relative isolate aspect-square overflow-hidden rounded-lg border border-border bg-border">
              {product.image_url ? (
                <Image
                  src={product.image_url}
                  alt=""
                  fill
                  sizes="(min-width: 1024px) 380px, calc(50vw - 54px)"
                  className="object-cover"
                />
              ) : (
                <Image
                  src="/brand/dada-logo.png"
                  alt=""
                  fill
                  sizes="(min-width: 1024px) 380px, calc(50vw - 54px)"
                  className="bg-surface-dim object-contain p-[22%] opacity-50"
                />
              )}

              {product.is_orderable && (
                <div className="absolute top-2 right-2 z-10 rounded-[10px] bg-surface/95 p-0.5 shadow-sm">
                  <QtyStepper
                    productId={id}
                    name={name}
                    priced={priced}
                    showPrices={showPrices}
                  />
                </div>
              )}
            </div>

            <div className="min-w-0 pt-2">
              <p className="line-clamp-2 min-h-[2.65rem] text-sm leading-[1.35] font-medium break-words text-ink">
                {name}
              </p>

              <p className="mt-1 flex min-h-4 min-w-0 items-center gap-1.5 text-xs text-muted">
                <span className="truncate">{unitLabel(product.unit, product.units_per_case)}</span>
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

              {showPrices && (
                <p className="mt-1 min-h-5 font-num text-sm font-semibold tabular-nums">
                  {caseCents != null ? (
                    formatEuros(caseCents, locale)
                  ) : (
                    <span className="text-xs font-normal text-muted">
                      {t("noPrice")}
                    </span>
                  )}
                </p>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
