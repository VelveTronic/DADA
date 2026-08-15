import type { Locale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import Link from "next/link";
import {
  setCurrentVariant,
  setProductAvailability,
} from "@/app/actions/staff-products";
import { requireStaff } from "@/lib/auth/guards";
import { localizedName, sanitizeSearch } from "@/lib/catalog/display";
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
  | "is_weighed"
  | "is_available"
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
  await requireStaff(locale);
  const t = await getTranslations("staff");
  // Shared catalog vocabulary — control labels and the weighed badge — reused
  // rather than duplicated into the staff namespace.
  const tCatalog = await getTranslations("catalog");

  const q = sanitizeSearch(rawQ ?? "");
  const page = Math.max(1, Number.parseInt(rawPage ?? "1", 10) || 1);

  const admin = createAdminClient();
  let query = admin
    .from("products")
    .select(
      "id, codart, base_sku, variant_suffix, is_current_variant, name, unit, is_weighed, is_available, price_1_cents, price_2_cents, price_3_cents, price_4_cents, price_5_cents, price_6_cents",
      { count: "exact" },
    );
  if (q) {
    query = query.or(
      `codart.ilike.%${q}%,base_sku.ilike.%${q}%,name->>zh.ilike.%${q}%,name->>es.ilike.%${q}%`,
    );
  }
  const from = (page - 1) * PAGE_SIZE;
  const { data, count, error } = await query
    .order("base_sku")
    .order("variant_suffix")
    .range(from, from + PAGE_SIZE - 1);
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
    <main className="mx-auto max-w-5xl p-4 sm:p-6">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-bold">{t("productsTitle")}</h1>
        <Link className="text-sm underline" href={`/${locale}/staff`}>
          ← {t("title")}
        </Link>
      </div>

      <form method="get" className="mt-4 flex gap-2">
        <input
          name="q"
          defaultValue={q}
          aria-label={t("searchPlaceholder")}
          placeholder={t("searchPlaceholder")}
          className="w-full rounded border px-3 py-2"
        />
        <button
          type="submit"
          aria-label={tCatalog("searchButton")}
          className="rounded bg-black px-4 py-2 text-white"
        >
          🔍
        </button>
      </form>

      <div className="mt-4 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs text-gray-500">
              <th className="py-2">{t("colProduct")}</th>
              <th>{t("colFlags")}</th>
              <th>{t("colPrices")}</th>
              <th />
            </tr>
          </thead>
          <tbody className="divide-y">
            {products.map((p) => {
              const groupSize = groupSizes.get(p.base_sku) ?? 1;
              const inGroup = groupSize > 1 || p.variant_suffix !== "";
              return (
                <tr
                  key={p.id}
                  className={`align-top ${p.is_available ? "" : "opacity-50"}`}
                >
                  <td className="py-2">
                    {/* The name gets its own element and the markers sit on the
                        wrapping meta line below, where a long name can never
                        clip them out of view. */}
                    <p className="font-medium">
                      {localizedName(p.name, locale)}
                    </p>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-gray-500">
                      <span>
                        {p.codart} · {p.unit}
                      </span>
                      {p.is_weighed && (
                        <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-800">
                          {tCatalog("weighed")}
                        </span>
                      )}
                      {inGroup && (
                        <span>
                          {t("variantGroup", { base: p.base_sku, n: groupSize })}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="py-2">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span
                        className={
                          p.is_available ? "text-green-700" : "text-gray-500"
                        }
                      >
                        {p.is_available ? t("available") : t("unavailable")}
                      </span>
                      {p.is_current_variant && (
                        <span className="rounded bg-blue-100 px-1.5 py-0.5 text-xs text-blue-800">
                          {t("current")}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="py-2">{pricedTiers(p)}/6</td>
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
                        <button
                          type="submit"
                          className="rounded border px-2 py-1 text-xs"
                        >
                          {p.is_available
                            ? t("makeUnavailable")
                            : t("makeAvailable")}
                        </button>
                      </form>
                      {!p.is_current_variant && (
                        <form action={setCurrentVariant}>
                          <input type="hidden" name="product_id" value={p.id} />
                          <input
                            type="hidden"
                            name="base_sku"
                            value={p.base_sku}
                          />
                          <input type="hidden" name="locale" value={locale} />
                          <button
                            type="submit"
                            className="rounded border px-2 py-1 text-xs"
                          >
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

      {products.length === 0 && (
        <p className="mt-10 text-center text-gray-400">
          {tCatalog("noResults")}
        </p>
      )}

      {totalPages > 1 && (
        <nav className="mt-6 flex items-center justify-center gap-4 text-sm">
          {page > 1 && (
            <Link
              className="underline"
              aria-label={tCatalog("prev")}
              href={pageHref(page - 1)}
            >
              ←
            </Link>
          )}
          <span className="text-gray-500">
            {page} / {totalPages}
          </span>
          {page < totalPages && (
            <Link
              className="underline"
              aria-label={tCatalog("next")}
              href={pageHref(page + 1)}
            >
              →
            </Link>
          )}
        </nav>
      )}
    </main>
  );
}
