import type { Locale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import Link from "next/link";
import { signOut } from "@/app/actions/auth";
import { toggleFavorite } from "@/app/actions/favorites";
import { requireCompanyUser } from "@/lib/auth/guards";
import { localizedName, sanitizeSearch } from "@/lib/catalog/display";
import { formatEuros } from "@/lib/money";
import type { CustomerCatalogProduct } from "@/lib/supabase/public.types";
import { createServerSupabase } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

/** A page of favorites with nothing in it must still be an empty IN list. */
const NO_MATCH_ID = "00000000-0000-0000-0000-000000000000";

export default async function CatalogPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: Locale }>;
  searchParams: Promise<{ q?: string; tab?: string; page?: string }>;
}) {
  const { locale } = await params;
  const { q: rawQ, tab: rawTab, page: rawPage } = await searchParams;
  setRequestLocale(locale);
  const { portalUser } = await requireCompanyUser(locale);
  const t = await getTranslations("catalog");
  const tc = await getTranslations("common");

  const q = sanitizeSearch(rawQ ?? "");
  const tab = rawTab === "favoritos" ? "favoritos" : "all";
  const page = Math.max(1, Number.parseInt(rawPage ?? "1", 10) || 1);

  const supabase = await createServerSupabase();

  const { data: favRows, error: favError } = await supabase
    .from("favorites")
    .select("product_id")
    .eq("company_id", portalUser.company_id);
  if (favError) console.error("catalog favorites query:", favError);
  const favoriteIds = new Set((favRows ?? []).map((row) => row.product_id));

  // Customers read the priced VIEW only: it carries exactly one price column,
  // resolved server-side from this company's tarifa.
  let query = supabase
    .from("products_priced")
    .select("*", { count: "exact" })
    .eq("is_current_variant", true);
  if (q) {
    query = query.or(
      `codart.ilike.%${q}%,name->>zh.ilike.%${q}%,name->>es.ilike.%${q}%`,
    );
  }
  if (tab === "favoritos") {
    const ids = [...favoriteIds];
    query = query.in("id", ids.length ? ids : [NO_MATCH_ID]);
  }
  const from = (page - 1) * PAGE_SIZE;
  const { data, count, error } = await query
    .order("codart", { ascending: true })
    .range(from, from + PAGE_SIZE - 1);
  if (error) console.error("catalog query:", error);
  const products: CustomerCatalogProduct[] = data ?? [];
  const totalPages = Math.max(1, Math.ceil((count ?? 0) / PAGE_SIZE));

  const href = (p: { q?: string; tab?: string; page?: number }) => {
    const sp = new URLSearchParams();
    const qq = p.q ?? q;
    const tt = p.tab ?? tab;
    if (qq) sp.set("q", qq);
    if (tt !== "all") sp.set("tab", tt);
    if ((p.page ?? 1) > 1) sp.set("page", String(p.page));
    const s = sp.toString();
    return `/${locale}/catalogo${s ? `?${s}` : ""}`;
  };

  return (
    <main className="mx-auto max-w-5xl p-4 sm:p-6">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-bold">{t("title")}</h1>
        <form action={signOut}>
          <input type="hidden" name="locale" value={locale} />
          <button type="submit" className="text-sm underline">
            {tc("logout")}
          </button>
        </form>
      </div>
      <p className="mt-1 text-sm text-gray-500">
        {portalUser.display_name ?? portalUser.companies.name}
      </p>

      <form method="get" className="mt-4 flex gap-2">
        {tab === "favoritos" && (
          <input type="hidden" name="tab" value="favoritos" />
        )}
        <input
          name="q"
          defaultValue={q}
          placeholder={t("searchPlaceholder")}
          className="w-full rounded border px-3 py-2"
        />
        <button type="submit" className="rounded bg-black px-4 py-2 text-white">
          {t("searchButton")}
        </button>
      </form>

      <nav className="mt-4 flex gap-4 border-b text-sm">
        <Link
          href={href({ tab: "all", page: 1 })}
          className={
            tab === "all"
              ? "border-b-2 border-black pb-2 font-semibold"
              : "pb-2 text-gray-500"
          }
        >
          {t("tabAll")}
        </Link>
        <Link
          href={href({ tab: "favoritos", page: 1 })}
          className={
            tab === "favoritos"
              ? "border-b-2 border-black pb-2 font-semibold"
              : "pb-2 text-gray-500"
          }
        >
          {t("tabFavorites")} ({favoriteIds.size})
        </Link>
      </nav>

      {products.length === 0 ? (
        <p className="mt-10 text-center text-gray-400">{t("noResults")}</p>
      ) : (
        <ul className="mt-2 divide-y">
          {products.map((p) => {
            // The view projects the products PK and NOT NULL columns; the
            // generated view types widen every column to `| null`.
            const id = p.id as string;
            const isFav = favoriteIds.has(id);
            return (
              <li
                key={id}
                className={`flex items-center gap-3 py-3 ${p.is_available ? "" : "opacity-45"}`}
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">
                    {localizedName(p.name, locale)}
                    {p.is_weighed && (
                      <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800">
                        {t("weighed")}
                      </span>
                    )}
                    {!p.is_available && (
                      <span className="ml-2 rounded bg-gray-200 px-1.5 py-0.5 text-xs text-gray-600">
                        {t("unavailable")}
                      </span>
                    )}
                  </p>
                  <p className="text-xs text-gray-500">
                    {p.codart} · {p.unit}
                  </p>
                </div>
                <p className="w-24 text-right text-sm font-semibold">
                  {p.price_cents != null ? (
                    formatEuros(p.price_cents, locale)
                  ) : (
                    <span className="font-normal text-gray-400">
                      {t("noPrice")}
                    </span>
                  )}
                </p>
                <form action={toggleFavorite}>
                  <input type="hidden" name="product_id" value={id} />
                  <input type="hidden" name="locale" value={locale} />
                  <input type="hidden" name="on" value={isFav ? "0" : "1"} />
                  <button
                    type="submit"
                    aria-label={isFav ? t("favRemove") : t("favAdd")}
                    className={`px-2 text-lg ${isFav ? "text-amber-500" : "text-gray-300"}`}
                  >
                    ★
                  </button>
                </form>
              </li>
            );
          })}
        </ul>
      )}

      {totalPages > 1 && (
        <nav className="mt-6 flex items-center justify-center gap-4 text-sm">
          {page > 1 && (
            <Link className="underline" href={href({ page: page - 1 })}>
              {t("prev")}
            </Link>
          )}
          <span className="text-gray-500">
            {t("pageOf", { page, total: totalPages })}
          </span>
          {page < totalPages && (
            <Link className="underline" href={href({ page: page + 1 })}>
              {t("next")}
            </Link>
          )}
        </nav>
      )}
    </main>
  );
}
