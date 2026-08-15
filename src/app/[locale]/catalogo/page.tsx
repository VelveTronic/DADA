import type { Locale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import Link from "next/link";
import { toggleFavorite } from "@/app/actions/favorites";
import { AppShell } from "@/components/app-shell";
import { QtyStepper } from "@/components/cart/qty-stepper";
import { BTN_PRIMARY, FIELD, GLASS_CARD } from "@/components/ui";
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

  // What the phone's bottom bar is allowed to add up: the price this render
  // resolved for each row it can actually order. A cart line that is not on
  // this page (or has no price, or has stopped being orderable) is missing from
  // the map, and the bar answers with a count instead of a wrong total.
  const cartPrices: Record<string, number> = {};
  for (const product of products) {
    if (product.id && product.is_orderable && product.price_cents != null) {
      cartPrices[product.id] = product.price_cents;
    }
  }

  const tabClass = (active: boolean) =>
    active
      ? "-mb-px border-b-2 border-brand pb-2 font-semibold"
      : "-mb-px border-b-2 border-transparent pb-2 text-muted transition-colors hover:text-ink";

  return (
    <AppShell
      locale={locale}
      nav="customer"
      user={{ name: portalUser.display_name ?? portalUser.companies.name }}
      cartPrices={cartPrices}
    >
      <h1 className="mt-8 text-2xl font-bold tracking-tight">{t("title")}</h1>

      <form method="get" className="mt-4 flex gap-2">
        {tab === "favoritos" && (
          <input type="hidden" name="tab" value="favoritos" />
        )}
        <input
          name="q"
          defaultValue={q}
          aria-label={t("searchPlaceholder")}
          placeholder={t("searchPlaceholder")}
          className={`w-full ${FIELD}`}
        />
        <button type="submit" className={BTN_PRIMARY}>
          {t("searchButton")}
        </button>
      </form>

      <nav className="mt-6 flex gap-5 border-b border-border text-sm">
        <Link
          href={href({ tab: "all", page: 1 })}
          className={tabClass(tab === "all")}
        >
          {t("tabAll")}
        </Link>
        <Link
          href={href({ tab: "favoritos", page: 1 })}
          className={tabClass(tab === "favoritos")}
        >
          {t("tabFavorites")} ({favoriteIds.size})
        </Link>
      </nav>

      {products.length === 0 ? (
        <p className={`${GLASS_CARD} mt-4 p-10 text-center text-muted`}>
          {t("noResults")}
        </p>
      ) : (
        <ul
          className={`${GLASS_CARD} mt-4 divide-y divide-border px-4 sm:px-5`}
        >
          {products.map((p) => {
            // The view projects the products PK and NOT NULL columns; the
            // generated view types widen every column to `| null`.
            const id = p.id as string;
            const isFav = favoriteIds.has(id);
            const name = localizedName(p.name, locale);
            // Every price is NULL until the owner's Wingest merge, so today this
            // renders as a disabled button explaining why; the moment a tarifa
            // price lands the same row becomes orderable with no code change.
            const priced = p.price_cents != null;
            return (
              <li
                key={id}
                // Wraps like the cart page's rows: the `− n +` pill is wider
                // than the `+` it replaces, and on a phone the name would be
                // squeezed to nothing if all four cells shared one line.
                className={`flex flex-wrap items-center gap-x-3 gap-y-2 py-3 ${p.is_available ? "" : "opacity-45"}`}
              >
                <div className="min-w-0 flex-1 basis-full sm:basis-0">
                  {/* Only the name truncates. Badges live on the wrapping meta
                      line below, where a long name can never clip them out of
                      view on a narrow phone. */}
                  <p className="truncate font-medium">{name}</p>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
                    <span>
                      {p.codart} · {p.unit}
                    </span>
                    {p.is_weighed && (
                      <span className="rounded-md bg-amber-100 px-1.5 py-0.5 text-amber-800">
                        {t("weighed")}
                      </span>
                    )}
                    {!p.is_available && (
                      <span className="rounded-md bg-gray-200 px-1.5 py-0.5 text-gray-600">
                        {t("unavailable")}
                      </span>
                    )}
                  </div>
                </div>
                <p className="w-24 text-right text-sm font-semibold">
                  {p.price_cents != null ? (
                    formatEuros(p.price_cents, locale)
                  ) : (
                    <span className="font-normal text-muted">
                      {t("noPrice")}
                    </span>
                  )}
                </p>
                {/* Ordering gates on is_orderable (is_available AND
                    is_current_variant): a row that cannot be ordered gets no
                    control at all, rather than one that would fail. The cell
                    keeps its width either way — sized for the `− n +` pill, not
                    the bare `+` — so the star column stays aligned down the
                    list however many products are already in the cart. */}
                <div className="flex w-24 shrink-0 justify-end">
                  {p.is_orderable && (
                    <QtyStepper productId={id} name={name} priced={priced} />
                  )}
                </div>
                <form action={toggleFavorite}>
                  <input type="hidden" name="product_id" value={id} />
                  <input type="hidden" name="locale" value={locale} />
                  <input type="hidden" name="on" value={isFav ? "0" : "1"} />
                  <button
                    type="submit"
                    aria-label={isFav ? t("favRemove") : t("favAdd")}
                    // Amber, not brand: a starred product is a state of the
                    // row, and the accent is spent on actions.
                    className={`px-2 text-lg ${isFav ? "text-amber-500" : "text-muted/40"}`}
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
            <Link
              className="text-brand-ink hover:underline"
              href={href({ page: page - 1 })}
            >
              {t("prev")}
            </Link>
          )}
          <span className="text-muted">
            {t("pageOf", { page, total: totalPages })}
          </span>
          {page < totalPages && (
            <Link
              className="text-brand-ink hover:underline"
              href={href({ page: page + 1 })}
            >
              {t("next")}
            </Link>
          )}
        </nav>
      )}
    </AppShell>
  );
}
