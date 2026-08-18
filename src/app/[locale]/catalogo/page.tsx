import type { Locale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { SearchIcon } from "@/components/icons";
import { BTN_PRIMARY, CARD, FIELD } from "@/components/ui";
import { beginCompanyUser, finishCompanyUser } from "@/lib/auth/guards";
import { localizedName, sanitizeSearch } from "@/lib/catalog/display";
import { perfRun } from "@/lib/perf";
import { getSetting } from "@/lib/settings";
import type { CustomerCatalogProduct } from "@/lib/supabase/public.types";
import { ProductRow } from "./product-row";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

/** A page of favorites with nothing in it must still be an empty IN list. */
const NO_MATCH_ID = "00000000-0000-0000-0000-000000000000";

/**
 * The product ids out of a favourites read, whether it answered or failed.
 *
 * Read twice from the same result — once as the favourites tab's filter, once
 * as the set the stars are drawn from — so it says once what a failed query
 * means here: no stars, never a broken page.
 */
function productIdsOf(result: { data: { product_id: string }[] | null }) {
  return (result.data ?? []).map((row) => row.product_id);
}

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
  const perf = perfRun(`/${locale}/catalogo`);
  const { supabase, pendingUser } = await beginCompanyUser(locale);
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

  // ROUND ONE. The restaurant's profile row is already in flight (see
  // `guards.ts`); the two reads that need nothing from it go out beside it
  // rather than behind it. `show_prices` has ridden along with page data since
  // it existed — the setting must never cost a page a round trip of its own —
  // and the categories are the same kind of read: the whole active list, the
  // same for every caller.
  const [portalUser, { data: categoryRows, error: categoryError }, showPrices] =
    await Promise.all([
      finishCompanyUser(pendingUser, locale),
      perf.step(
        "categories",
        supabase
          .from("categories")
          .select("id, erp_code, name, sort_order")
          .eq("is_active", true),
      ),
      perf.step("settings", getSetting(supabase, "show_prices")),
    ]);

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
  const productsQuery = (favoriteFilter: string[] | null) => {
    let query = supabase
      .from("products_priced")
      .select("*", { count: "exact" })
      .eq("is_current_variant", true);
    if (q) {
      query = query.or(
        `codart.ilike.%${q}%,name->>zh.ilike.%${q}%,name->>es.ilike.%${q}%`,
      );
    }
    if (favoriteFilter) {
      query = query.in("id", favoriteFilter.length ? favoriteFilter : [NO_MATCH_ID]);
    }
    if (activeCategory) query = query.eq("category_id", activeCategory.id);
    const from = (page - 1) * PAGE_SIZE;
    return query
      .order("codart", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
  };

  // ROUND TWO. The favourites are the one read that needed the profile — they
  // are keyed by the restaurant's company — and the page of products is the one
  // read that needed the categories, for `?cat=`. Both are answered now, and on
  // an ordinary catalogue load they are answered TOGETHER: the star on a row and
  // the row itself have nothing to say to each other either.
  //
  // The favourites TAB is the single shape where they cannot go out side by
  // side, because there the id list IS the filter. Only that tab pays a third
  // round trip, and it is the tab with the shortest list.
  const pendingFavorites = perf.step(
    "favorites",
    supabase
      .from("favorites")
      .select("product_id")
      .eq("company_id", portalUser.company_id),
  );
  const favoriteFilter =
    tab === "favoritos" ? productIdsOf(await pendingFavorites) : null;

  const [favResult, { data, count, error }] = await Promise.all([
    pendingFavorites,
    perf.step("products", productsQuery(favoriteFilter)),
  ]);

  if (favResult.error) console.error("catalog favorites query:", favResult.error);
  const favoriteIds = new Set(productIdsOf(favResult));

  if (error) console.error("catalog query:", error);
  const products: CustomerCatalogProduct[] = data ?? [];
  const totalPages = Math.max(1, Math.ceil((count ?? 0) / PAGE_SIZE));
  perf.end();

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

  // 44px tall, which is the whole reason for the inline-flex: an anchor is only
  // as tall as its text, and these two are the page's main switch on a phone.
  const tabClass = (active: boolean) =>
    active
      ? "-mb-px inline-flex h-11 items-center border-b-2 border-brand font-semibold"
      : "-mb-px inline-flex h-11 items-center border-b-2 border-transparent text-muted transition-colors hover:text-ink";

  // Chips, not a second row of underlined tabs: the categories are a FILTER over
  // whatever the tabs above are showing, and they used to be drawn in the same
  // vocabulary as the thing they filter. A pill also gives the touch target its
  // own visible edges — 44px tall, wide enough for one Chinese category name.
  const chipClass = (active: boolean) =>
    active
      ? "inline-flex h-11 shrink-0 items-center whitespace-nowrap rounded-full border border-brand/30 bg-brand-soft px-4 font-semibold text-brand-ink"
      : "inline-flex h-11 shrink-0 items-center whitespace-nowrap rounded-full border border-border bg-white/70 px-4 text-muted transition-colors hover:border-brand hover:text-brand-ink";

  // Search, a category or the favourites tab: anything that can make the list
  // come back empty, so the empty state can offer the way back out of it.
  const filtered = Boolean(q) || activeCategory !== null || tab === "favoritos";

  return (
    <AppShell
      locale={locale}
      user={{ name: portalUser.display_name ?? portalUser.companies.name }}
      cartPrices={cartPrices}
      showPrices={showPrices}
    >
      <h1 className="mt-8 text-2xl font-bold tracking-tight">{t("title")}</h1>

      <form method="get" className="mt-4 flex items-center gap-2">
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
          className={`h-11 w-full ${FIELD}`}
        />
        {/* The oversized red block on the owner's phone was this button losing a
            fight with the input's `w-full`: both are flex items, the input asked
            for 100% of the row, and the overflow was settled by SHRINKING the
            button to its min-content — which for 搜索 is one character wide, so
            the label wrapped onto two lines and the button grew a head taller
            than the field beside it. `shrink-0` is the fix; the icon is the
            improvement. On a phone it is a 44px square carrying the loupe (the
            same glyph the header's 搜索 uses, so the two read as one action) and
            the word appears from `sm` up, where there is room for it. */}
        <button
          type="submit"
          aria-label={t("searchButton")}
          className={`${BTN_PRIMARY} inline-flex h-11 shrink-0 items-center justify-center gap-2 whitespace-nowrap`}
        >
          <SearchIcon />
          <span className="hidden sm:inline">{t("searchButton")}</span>
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
        <nav className="-mx-4 mt-3 flex gap-2 overflow-x-auto px-4 py-1 text-sm sm:mx-0 sm:px-0">
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
        // The empty state says what happened AND offers the way out of it: a
        // search that matched nothing, or a category with nothing in it, used to
        // be a grey sentence in the middle of a card with no control on it — the
        // customer's only move was to find the filter they set and undo it by
        // hand. The link is only there when something IS filtering; on a truly
        // empty catalogue it would be a link to the same empty page.
        <div
          className={`${CARD} mt-4 flex flex-col items-center gap-3 px-6 py-12 text-center`}
        >
          <span className="flex size-12 items-center justify-center rounded-full bg-border text-muted">
            <SearchIcon />
          </span>
          <p className="text-muted">{t("noResults")}</p>
          {filtered && (
            <Link
              href={href({ q: "", tab: "all", cat: "", page: 1 })}
              // Same shape as the pager below — the two quiet navigations on
              // this page, both 44px and both brand-ink on the card.
              className="inline-flex h-11 items-center rounded-lg px-3 text-sm text-brand-ink underline underline-offset-4 transition-colors hover:bg-brand-soft"
            >
              {t("clearFilters")}
            </Link>
          )}
        </div>
      ) : (
        <ul className={`${CARD} mt-4 divide-y divide-border px-3 sm:px-5`}>
          {/* The row itself lives in `product-row.tsx`: it is where the layout
              that this page's customers press lives, and it is the one piece of
              the catalogue worth being able to mount on its own. */}
          {products.map((p) => (
            <ProductRow
              key={p.id as string}
              product={p}
              locale={locale}
              isFavorite={favoriteIds.has(p.id as string)}
              showPrices={showPrices}
            />
          ))}
        </ul>
      )}

      {totalPages > 1 && (
        <nav className="mt-6 flex items-center justify-center gap-2 text-sm">
          {/* Two anchors at the bottom of a fifty-row list, thumbed on a phone:
              44px tall and padded wide enough to hit without aiming. */}
          {page > 1 && (
            <Link
              className="inline-flex h-11 items-center rounded-lg px-3 text-brand-ink transition-colors hover:bg-brand-soft"
              href={href({ page: page - 1 })}
            >
              {t("prev")}
            </Link>
          )}
          <span className="px-2 text-muted tabular-nums">
            {t("pageOf", { page, total: totalPages })}
          </span>
          {page < totalPages && (
            <Link
              className="inline-flex h-11 items-center rounded-lg px-3 text-brand-ink transition-colors hover:bg-brand-soft"
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
