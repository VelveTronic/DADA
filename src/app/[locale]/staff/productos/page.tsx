import type { Locale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import Link from "next/link";
import {
  setCurrentVariant,
  setProductAvailability,
  setProductWeighed,
} from "@/app/actions/staff-products";
import { ProductThumb } from "@/components/product-thumb";
import { StaffShell } from "@/components/staff-shell";
import { BTN_PRIMARY, BTN_QUIET, FIELD, GLASS_CARD } from "@/components/ui";
import { requireStaff } from "@/lib/auth/guards";
import { localizedName, sanitizeSearch, unitLabel } from "@/lib/catalog/display";
import { perfRun } from "@/lib/perf";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/database.types";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

/**
 * Exactly the columns this page renders. The six price columns are readable only
 * through the service-role client — authenticated holds no column privilege on
 * them — which is why the query below is an admin query, and why it runs only
 * after `requireStaff`.
 */
type StaffProductRow = Pick<
  Database["public"]["Tables"]["products"]["Row"],
  | "id"
  | "codart"
  | "base_sku"
  | "variant_suffix"
  | "is_current_variant"
  | "name"
  | "unit"
  | "units_per_case"
  | "is_weighed"
  | "is_available"
  | "image_url"
  | "price_1_cents"
  | "price_2_cents"
  | "price_3_cents"
  | "price_4_cents"
  | "price_5_cents"
  | "price_6_cents"
>;

/** How many of the six tarifa tiers actually carry a price. */
function pricedTiers(p: StaffProductRow): number {
  return [
    p.price_1_cents,
    p.price_2_cents,
    p.price_3_cents,
    p.price_4_cents,
    p.price_5_cents,
    p.price_6_cents,
  ].filter((cents) => cents != null).length;
}

export default async function StaffProductsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: Locale }>;
  searchParams: Promise<{ q?: string; page?: string }>;
}) {
  const { locale } = await params;
  const { q: rawQ, page: rawPage } = await searchParams;
  setRequestLocale(locale);
  const perf = perfRun(`/${locale}/staff/productos`);
  // Sequential on purpose: the query below is on the SERVICE-ROLE client — the
  // six price tiers are reachable no other way — so it runs only once the guard
  // has said this caller is staff.
  const { staffUser } = await requireStaff(locale);
  const t = await getTranslations("staff");
  // Shared catalog vocabulary — control labels, the weighed badge, the pager —
  // reused rather than duplicated into the staff namespace.
  const tCatalog = await getTranslations("catalog");

  const q = sanitizeSearch(rawQ ?? "");
  const page = Math.max(1, Number.parseInt(rawPage ?? "1", 10) || 1);

  const admin = createAdminClient();
  let query = admin
    .from("products")
    .select(
      "id, codart, base_sku, variant_suffix, is_current_variant, name, unit, units_per_case, is_weighed, is_available, image_url, price_1_cents, price_2_cents, price_3_cents, price_4_cents, price_5_cents, price_6_cents",
      { count: "exact" },
    );
  if (q) {
    query = query.or(
      `codart.ilike.%${q}%,base_sku.ilike.%${q}%,name->>zh.ilike.%${q}%,name->>es.ilike.%${q}%`,
    );
  }
  const from = (page - 1) * PAGE_SIZE;
  const { data, count, error } = await perf.step(
    "products",
    query
      .order("base_sku")
      .order("variant_suffix")
      .range(from, from + PAGE_SIZE - 1),
  );
  perf.end();
  if (error) console.error("staff products query:", error);
  const products: StaffProductRow[] = data ?? [];
  const totalPages = Math.max(1, Math.ceil((count ?? 0) / PAGE_SIZE));

  // Page-local group sizes. base_sku ordering keeps a variant group contiguous,
  // so the count is exact except for a group split across a page boundary.
  const groupSizes = new Map<string, number>();
  for (const p of products) {
    groupSizes.set(p.base_sku, (groupSizes.get(p.base_sku) ?? 0) + 1);
  }

  const pageHref = (target: number) => {
    const sp = new URLSearchParams();
    if (q) sp.set("q", q);
    if (target > 1) sp.set("page", String(target));
    const s = sp.toString();
    return `/${locale}/staff/productos${s ? `?${s}` : ""}`;
  };

  return (
    <StaffShell
      locale={locale}
      title={t("productsTitle")}
      breadcrumb={t("nav.products")}
      user={{
        name: staffUser.display_name ?? staffUser.id,
        role: staffUser.role,
      }}
    >
      <form method="get" className="mt-4 flex gap-2">
        <input
          name="q"
          defaultValue={q}
          aria-label={t("searchPlaceholder")}
          placeholder={t("searchPlaceholder")}
          className={`w-full ${FIELD}`}
        />
        <button
          type="submit"
          aria-label={tCatalog("searchButton")}
          className={BTN_PRIMARY}
        >
          🔍
        </button>
      </form>

      {products.length === 0 ? (
        <p className={`${GLASS_CARD} mt-4 p-10 text-center text-muted`}>
          {tCatalog("noResults")}
        </p>
      ) : (
        <div className={`${GLASS_CARD} mt-4 overflow-x-auto p-4 sm:p-5`}>
          <table className="w-full text-sm">
            <thead>
              {/* Headers step BACK: small, muted and unbolded, so the weight in
                  the table belongs to the product names under them. */}
              <tr className="border-b border-border text-left text-xs font-medium text-muted">
                <th className="py-2 font-medium">{t("colProduct")}</th>
                <th className="py-2 font-medium">{t("colFlags")}</th>
                {/* A count, so it is aligned as one — with its column. */}
                <th className="py-2 text-right font-medium">
                  {t("colPrices")}
                </th>
                {/* Named for screen readers, blank on screen: the column holds
                    only buttons, which label themselves. */}
                <th className="py-2 font-medium">
                  <span className="sr-only">{t("colActions")}</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {products.map((p) => {
                const groupSize = groupSizes.get(p.base_sku) ?? 1;
                const inGroup = groupSize > 1 || p.variant_suffix !== "";
                return (
                  <tr
                    key={p.id}
                    className={`align-top transition-colors hover:bg-white/50 ${
                      p.is_available ? "" : "opacity-50"
                    }`}
                  >
                    <td className="py-2">
                      {/* The row is align-top, so the thumbnail sits with the
                          name rather than centring itself against a cell whose
                          height the wrapping meta line decides. */}
                      <div className="flex items-start gap-3">
                        <ProductThumb src={p.image_url} />
                        <div className="min-w-0">
                          {/* The name gets its own element and the markers sit
                              on the wrapping meta line below, where a long name
                              can never clip them out of view. */}
                          <p className="font-medium">
                            {localizedName(p.name, locale)}
                          </p>
                          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
                            {/* The factor rides on the unit, exactly as the
                                catalogue prints it (`CAJA×24`, silent at 1):
                                it is what multiplies the tarifa price into the
                                per-caja price a customer sees, so staff
                                comparing a price against the ERP need it on the
                                same line as the codart. */}
                            <span>
                              {p.codart} · {unitLabel(p.unit, p.units_per_case)}
                            </span>
                            {p.is_weighed && (
                              <span className="rounded-md bg-amber-100 px-1.5 py-0.5 text-amber-800">
                                {tCatalog("weighed")}
                              </span>
                            )}
                            {inGroup && (
                              <span>
                                {t("variantGroup", {
                                  base: p.base_sku,
                                  n: groupSize,
                                })}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="py-2">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span
                          className={
                            p.is_available ? "text-green-700" : "text-muted"
                          }
                        >
                          {p.is_available ? t("available") : t("unavailable")}
                        </span>
                        {p.is_current_variant && (
                          <span className="rounded-md bg-blue-100 px-1.5 py-0.5 text-xs text-blue-800">
                            {t("current")}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="py-2 text-right tabular-nums">
                      {pricedTiers(p)}/6
                    </td>
                    <td className="py-2 text-right">
                      <div className="flex justify-end gap-2">
                        <form action={setProductAvailability}>
                          <input type="hidden" name="product_id" value={p.id} />
                          <input type="hidden" name="locale" value={locale} />
                          <input
                            type="hidden"
                            name="available"
                            value={p.is_available ? "0" : "1"}
                          />
                          <button type="submit" className={BTN_QUIET}>
                            {p.is_available
                              ? t("makeUnavailable")
                              : t("makeAvailable")}
                          </button>
                        </form>
                        {/* The 称重 switch, beside the 停售 one it is modelled
                            on. It is the only source `is_weighed` has for an
                            article the ERP calls UNIDAD — freepos never filled
                            the column and Wingest can only say KG — and the
                            badge on the row above is what it turns on. */}
                        <form action={setProductWeighed}>
                          <input type="hidden" name="product_id" value={p.id} />
                          <input type="hidden" name="locale" value={locale} />
                          <input
                            type="hidden"
                            name="weighed"
                            value={p.is_weighed ? "0" : "1"}
                          />
                          <button type="submit" className={BTN_QUIET}>
                            {p.is_weighed
                              ? t("makeNotWeighed")
                              : t("makeWeighed")}
                          </button>
                        </form>
                        {!p.is_current_variant && (
                          <form action={setCurrentVariant}>
                            <input
                              type="hidden"
                              name="product_id"
                              value={p.id}
                            />
                            <input
                              type="hidden"
                              name="base_sku"
                              value={p.base_sku}
                            />
                            <input type="hidden" name="locale" value={locale} />
                            <button type="submit" className={BTN_QUIET}>
                              {t("makeCurrent")}
                            </button>
                          </form>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {totalPages > 1 && (
        <nav className="mt-6 flex items-center justify-center gap-4 text-sm">
          {page > 1 && (
            <Link
              className="text-brand-ink hover:underline"
              aria-label={tCatalog("prev")}
              href={pageHref(page - 1)}
            >
              ←
            </Link>
          )}
          <span className="text-muted">
            {tCatalog("pageOf", { page, total: totalPages })}
          </span>
          {page < totalPages && (
            <Link
              className="text-brand-ink hover:underline"
              aria-label={tCatalog("next")}
              href={pageHref(page + 1)}
            >
              →
            </Link>
          )}
        </nav>
      )}
    </StaffShell>
  );
}
