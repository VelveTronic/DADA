import type { Locale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import Link from "next/link";
import { toggleFavorite } from "@/app/actions/favorites";
import { AppShell } from "@/components/app-shell";
import { QtyStepper } from "@/components/cart/qty-stepper";
import { ProductThumb } from "@/components/product-thumb";
import { BTN_PRIMARY, FIELD, GLASS_CARD } from "@/components/ui";
import { requireCompanyUser } from "@/lib/auth/guards";
import { localizedName, sanitizeSearch, unitLabel } from "@/lib/catalog/display";
import { formatEuros } from "@/lib/money";
import { getSetting } from "@/lib/settings";
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
  searchParams: Promise<{
    q?: string;
    tab?: string;
    page?: string;
    cat?: string;
    focus?: string;
  }>;
}) {
  const { locale } = await params;
  const {
    q: rawQ,
    tab: rawTab,
    page: rawPage,
    cat: rawCat,
    focus: rawFocus,
  } = await searchParams;
  setRequestLocale(locale);
  const { portalUser } = await requireCompanyUser(locale);
  const t = await getTranslations("catalog");

  const q = sanitizeSearch(rawQ ?? "");
  const tab = rawTab === "favoritos" ? "favoritos" : "all";
  const page = Math.max(1, Number.parseInt(rawPage ?? "1", 10) || 1);
  // What the header's 搜索 icon links to (`?focus=search`). The whole feature is
  // this boolean and the `autoFocus` below: React DOM renders the real
  // `autofocus` attribute server-side, so the browser puts the caret in the box
  // as it parses the page — no client component, no effect, no second search UI
  // to keep in step with this one. Compared strictly, so nothing else in the
  // parameter's value can turn it on, and it is deliberately NOT carried by
  // `href()`: it belongs to the one navigation that asked for it.
  const focusSearch = rawFocus === "search";

  const supabase = await createServerSupabase();

  // Three independent reads, and the products query below needs all of them
  // before it can be built (favourites for the tab, categories for `?cat=`), so
  // they race rather than queue. `show_prices` rides along here for exactly that
  // reason: the setting costs this page no round trip of its own, and a page
  // that reads it sequentially would have paid ~50ms for a boolean.
  const [
    { data: favRows, error: favError },
    { data: categoryRows, error: categoryError },
    showPrices,
  ] = await Promise.all([
    supabase
      .from("favorites")
      .select("product_id")
      .eq("company_id", portalUser.company_id),
    supabase
      .from("categories")
      .select("id, erp_code, name, sort_order")
      .eq("is_active", true),
    getSetting(supabase, "show_prices"),
  ]);
  if (favError) console.error("catalog favorites query:", favError);
  const favoriteIds = new Set((favRows ?? []).map((row) => row.product_id));

  if (categoryError) console.error("catalog categories query:", categoryError);
  // Ordered here rather than in SQL: `name` is jsonb, so only the app knows
  // which of {zh, es} this locale actually shows — and that name is the
  // tiebreaker for the many freepos sort values that collide on one number.
  const categories = (categoryRows ?? [])
    .map((row) => ({ ...row, label: localizedName(row.name, locale) }))
    .sort(
      (a, b) =>
        a.sort_order - b.sort_order || a.label.localeCompare(b.label, locale),
    );
  // The whole validation of ?cat=: an erp_code that is not an active category
  // resolves to nothing and the page renders unfiltered, never a failed query.
  const activeCategory = categories.find((c) => c.erp_code === rawCat) ?? null;

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
  if (activeCategory) query = query.eq("category_id", activeCategory.id);
  const from = (page - 1) * PAGE_SIZE;
  const { data, count, error } = await query
    .order("codart", { ascending: true })
    .range(from, from + PAGE_SIZE - 1);
  if (error) console.error("catalog query:", error);
  const products: CustomerCatalogProduct[] = data ?? [];
  const totalPages = Math.max(1, Math.ceil((count ?? 0) / PAGE_SIZE));

  const href = (p: {
    q?: string;
    tab?: string;
    page?: number;
    cat?: string;
  }) => {
    const sp = new URLSearchParams();
    const qq = p.q ?? q;
    const tt = p.tab ?? tab;
    // A category survives a search or a tab switch; only the "all" chip clears
    // it, by passing the empty string. Every caller that changes the filter
    // passes page: 1, so a narrower result set never lands on a page past its end.
    const cc = p.cat ?? activeCategory?.erp_code ?? "";
    if (qq) sp.set("q", qq);
    if (tt !== "all") sp.set("tab", tt);
    if (cc) sp.set("cat", cc);
    if ((p.page ?? 1) > 1) sp.set("page", String(p.page));
    const s = sp.toString();
    return `/${locale}/catalogo${s ? `?${s}` : ""}`;
  };

  // What the phone's bottom bar is allowed to add up: the CAJA price this render
  // resolved for each row it can actually order — the same figure the row shows,
  // because the cart's quantities are cajas too. A cart line that is not on this
  // page (or has no price, or has stopped being orderable) is missing from the
  // map, and the bar answers with a count instead of a wrong total.
  //
  // With the owner's switch OFF the map is not built at all. The bar renders no
  // amount either way, and a page that deliberately shows no prices has no
  // business shipping the whole visible tarifa down to the browser inside its
  // RSC payload. Nothing else reads it: every other amount on a customer page is
  // server-rendered behind the same flag.
  const cartPrices: Record<string, number> | undefined = showPrices ? {} : undefined;
  if (cartPrices) {
    for (const product of products) {
      if (
        product.id &&
        product.is_orderable &&
        product.price_per_case_cents != null
      ) {
        cartPrices[product.id] = product.price_per_case_cents;
      }
    }
  }

  const tabClass = (active: boolean) =>
    active
      ? "-mb-px border-b-2 border-brand pb-2 font-semibold"
      : "-mb-px border-b-2 border-transparent pb-2 text-muted transition-colors hover:text-ink";

  // The tabs' underline, minus the -mb-px that makes it sit ON the nav's border:
  // inside a horizontal scroller that overhang would be clipped away.
  const chipClass = (active: boolean) =>
    active
      ? "shrink-0 whitespace-nowrap border-b-2 border-brand pb-1 font-semibold"
      : "shrink-0 whitespace-nowrap border-b-2 border-transparent pb-1 text-muted transition-colors hover:text-ink";

  return (
    <AppShell
      locale={locale}
      user={{ name: portalUser.display_name ?? portalUser.companies.name }}
      cartPrices={cartPrices}
      showPrices={showPrices}
    >
      <h1 className="mt-8 text-2xl font-bold tracking-tight">{t("title")}</h1>

      <form method="get" className="mt-4 flex gap-2">
        {tab === "favoritos" && (
          <input type="hidden" name="tab" value="favoritos" />
        )}
        {/* A GET form submits only its own fields, so the chosen category has to
            ride along or searching would silently widen the result set. */}
        {activeCategory && (
          <input type="hidden" name="cat" value={activeCategory.erp_code} />
        )}
        <input
          name="q"
          defaultValue={q}
          // False on every ordinary catalogue load: focus is only stolen when
          // the customer pressed 搜索 and asked for exactly this box.
          autoFocus={focusSearch}
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

      {categories.length > 0 && (
        // Full-bleed on a phone: the row scrolls past the page gutter, so the
        // last chip is visibly cut off rather than looking like the end of it.
        <nav className="-mx-4 mt-3 flex gap-4 overflow-x-auto px-4 text-sm sm:mx-0 sm:px-0">
          <Link
            href={href({ cat: "", page: 1 })}
            className={chipClass(!activeCategory)}
          >
            {t("catAll")}
          </Link>
          {categories.map((c) => (
            <Link
              key={c.id}
              href={href({ cat: c.erp_code, page: 1 })}
              className={chipClass(activeCategory?.id === c.id)}
            >
              {c.label}
            </Link>
          ))}
        </nav>
      )}

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
            // The price of ONE CAJA, computed in the view as
            // `price_cents x units_per_case` — exact integer multiplication, and
            // the only money figure this page knows. Quantities are cajas, so
            // this is the number that belongs beside them.
            //
            // It is null exactly when the tarifa price is (the factor is NOT
            // NULL), which is why it also answers "can this row be ordered": every
            // price is NULL until the owner's Wingest merge, so today an unpriced
            // row renders as a disabled button explaining why, and the moment a
            // tarifa price lands the same row becomes orderable with no code change.
            const caseCents = p.price_per_case_cents;
            const priced = caseCents != null;
            return (
              <li
                key={id}
                // Wraps like the cart page's rows: the `− n +` pill is wider
                // than the `+` it replaces, and on a phone the name would be
                // squeezed to nothing if all four cells shared one line.
                className={`flex flex-wrap items-center gap-x-3 gap-y-2 py-3 ${p.is_available ? "" : "opacity-45"}`}
              >
                {/* The thumbnail rides INSIDE the name cell rather than beside
                    it: the cell is `basis-full` on a phone, so a sibling of it
                    would be pushed onto a line of its own with nothing else. */}
                <div className="flex min-w-0 flex-1 basis-full items-center gap-3 sm:basis-0">
                  <ProductThumb src={p.image_url} />
                  <div className="min-w-0 flex-1">
                    {/* Only the name truncates. Badges live on the wrapping meta
                        line below, where a long name can never clip them out of
                        view on a narrow phone. */}
                    <p className="truncate font-medium">{name}</p>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
                      {/* `1-002 · CAJA×24`: the factor is what turns the price
                          beside it into an offer a restaurant can judge. It is
                          silent at 1 — see `unitLabel`. */}
                      <span>
                        {p.codart} · {unitLabel(p.unit, p.units_per_case)}
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
                </div>
                {/* The whole cell goes when the owner has prices off — 价格待定
                    included. It is the price column's placeholder, so leaving it
                    behind would put a note ABOUT pricing on a page that is
                    deliberately not talking about prices. Ordering is unaffected:
                    the stepper below is gated on `priced`, which the server
                    resolved either way. */}
                {showPrices && (
                  <p className="w-24 text-right text-sm font-semibold">
                    {caseCents != null ? (
                      formatEuros(caseCents, locale)
                    ) : (
                      <span className="font-normal text-muted">
                        {t("noPrice")}
                      </span>
                    )}
                  </p>
                )}
                {/* Ordering gates on is_orderable (is_available AND
                    is_current_variant): a row that cannot be ordered gets no
                    control at all, rather than one that would fail. The cell
                    keeps its width either way — sized for the `− n +` pill, not
                    the bare `+` — so the star column stays aligned down the
                    list however many products are already in the cart. */}
                <div className="flex w-24 shrink-0 justify-end">
                  {p.is_orderable && (
                    <QtyStepper
                      productId={id}
                      name={name}
                      priced={priced}
                      showPrices={showPrices}
                    />
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
