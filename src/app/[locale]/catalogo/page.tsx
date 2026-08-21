import type { Locale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { CatalogViewSwitcher } from "@/components/catalog-view-switcher";
import { SearchIcon } from "@/components/icons";
import { ProductGrid } from "@/components/product-grid";
import { ProductRow } from "@/components/product-row";
import { beginCompanyUser, finishCompanyUser } from "@/lib/auth/guards";
import { sortCategories } from "@/lib/categories";
import { perfRun } from "@/lib/perf";
import { getSetting } from "@/lib/settings";
import type { CustomerCatalogProduct } from "@/lib/supabase/public.types";
import { CategoryRail, type RailEntry } from "./category-rail";

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
  // No `q`: searching is its own page now (`/buscar`), and the box at the top of
  // this one is a LINK to it. A catalogue that also answered `?q=` would be a
  // second search implementation to keep in step with that one — and the rail
  // beside the list is this page's filter.
  searchParams: Promise<{
    tab?: string;
    page?: string;
    cat?: string;
  }>;
}) {
  const { locale } = await params;
  const { tab: rawTab, page: rawPage, cat: rawCat } = await searchParams;
  setRequestLocale(locale);
  const perf = perfRun(`/${locale}/catalogo`);
  const { supabase, pendingUser } = await beginCompanyUser(locale);
  const t = await getTranslations("catalog");

  const tab = rawTab === "favoritos" ? "favoritos" : "all";
  const page = Math.max(1, Number.parseInt(rawPage ?? "1", 10) || 1);

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
  //
  // The comparator itself lives in `lib/categories.ts` because the back office's
  // 分类管理 page reorders this very rail: the ↑/↓ buttons there move rows in the
  // list THIS function produces, so both screens import one function rather than
  // keeping two sorts in step by hand.
  const categories = sortCategories(categoryRows ?? [], locale);
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

  const href = (p: { tab?: string; page?: number; cat?: string }) => {
    const sp = new URLSearchParams();
    const tt = p.tab ?? tab;
    // Every rail entry passes BOTH halves of the filter, so picking one clears
    // the other: the rail is a single-select list — 全部, 常购, one category —
    // and two of its entries could not be lit at once without lying about what
    // the pane beside it is showing. The pager is the only caller that passes
    // neither and inherits both. Everything that changes the filter passes
    // page: 1, so a narrower result set never lands on a page past its end.
    const cc = p.cat ?? activeCategory?.erp_code ?? "";
    if (tt !== "all") sp.set("tab", tt);
    if (cc) sp.set("cat", cc);
    if ((p.page ?? 1) > 1) sp.set("page", String(p.page));
    const s = sp.toString();
    return `/${locale}/catalogo${s ? `?${s}` : ""}`;
  };

  // A `?page` past the end lands on the real last page instead of an empty pane
  // under a header still saying 共 30 种 — the shape a bookmarked page 3 takes
  // once the ERP re-import shrinks the category. The count arrives on the SAME
  // response as the rows, so the clamp is known here for free and the extra
  // round trip is paid only in the rare over-range case. `href` is reused so the
  // tab and the category ride along exactly as the pager encodes them.
  if (page > totalPages) redirect(href({ page: totalPages }));

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

  // 全部 is the rail's own entry rather than the absence of one: a bare
  // `/catalogo` is exactly it, which is what keeps every existing link into the
  // catalogue landing on a lit rail.
  const railEntries: RailEntry[] = [
    {
      id: "all",
      label: t("railAll"),
      href: href({ tab: "all", cat: "", page: 1 }),
      active: tab === "all" && !activeCategory,
    },
    {
      id: "favoritos",
      label: t("railFavorites"),
      href: href({ tab: "favoritos", cat: "", page: 1 }),
      active: tab === "favoritos",
      count: favoriteIds.size,
    },
    ...categories.map((c) => ({
      id: c.id,
      label: c.label,
      href: href({ tab: "all", cat: c.erp_code, page: 1 }),
      active: tab === "all" && activeCategory?.id === c.id,
    })),
  ];

  // The pane says which rail entry it is answering, in the rail's own words.
  const paneLabel =
    tab === "favoritos"
      ? t("paneFavorites")
      : (activeCategory?.label ?? t("railAll"));

  // A category or the favourites list: anything that can make the pane come back
  // empty, so the empty state can offer the way back out of it.
  const filtered = activeCategory !== null || tab === "favoritos";

  const emptyState = (
    <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
      <span className="flex size-12 items-center justify-center rounded-full bg-border text-muted">
        <SearchIcon />
      </span>
      <p className="text-muted">{t("noResults")}</p>
      {filtered && (
        <Link
          href={href({ tab: "all", cat: "", page: 1 })}
          className="inline-flex h-11 items-center rounded-lg px-3 text-sm text-brand-ink underline underline-offset-4 transition-colors hover:bg-brand-soft"
        >
          {t("clearFilters")}
        </Link>
      )}
    </div>
  );

  const productList = (
    <ul>
      {products.map((p) => (
        <ProductRow
          key={p.id as string}
          product={p}
          locale={locale}
          showPrices={showPrices}
        />
      ))}
    </ul>
  );

  const productGrid = (
    <ProductGrid products={products} locale={locale} showPrices={showPrices} />
  );

  return (
    <AppShell
      locale={locale}
      user={{ name: portalUser.display_name ?? portalUser.companies.name }}
      cartPrices={cartPrices}
      showPrices={showPrices}
      // The two panes below scroll on their own, so the shell must not let the
      // document scroll behind them — see the layout note in `app-shell.tsx`.
      layout="viewport"
    >
      <div className="flex-none">
        {/* A LINK dressed as a search field, not a field. Searching is its own
            screen (`/buscar`): it has the keyboard, the history and the result
            list, and it is reached from four places in the app — a real input
            here would be a second search UI to keep in step with that one, and
            it would put a keyboard over the catalogue every time a thumb landed
            near the top of the screen. It is announced as what it does; the grey
            wording inside is the same sentence, so the two cannot drift. */}
        <Link
          href={`/${locale}/buscar`}
          aria-label={t("searchPlaceholder")}
          className="mx-4 my-2 flex h-10 items-center gap-2 rounded-[10px] bg-surface-dim px-3 text-sm text-faint transition-colors hover:text-muted"
        >
          {/* The shared glyph is drawn at 24px for the 44px header buttons; in
              this 40px field (`h-10`) it is the design's small loupe, and the
              box around it is what resizes it — `icons.tsx` fixes the size on
              the SVG itself. */}
          <span aria-hidden className="flex-none [&>svg]:size-4">
            <SearchIcon />
          </span>
          {t("searchPlaceholder")}
        </Link>
        {/* The mockup drew a red notice strip under the search box (提交后由客服
            排单…); the owner cut it on 2026-08-19 — the sentence earned no pixels
            on every catalogue visit. The box's `my-2` is what now separates it
            from the pane header below. */}
      </div>

      {/* The two panes. `min-h-0` is what makes them scroll rather than stretch:
          a flex child's automatic minimum is its CONTENT, so without it a
          fifty-row list would push this row taller than the shell and the whole
          document would scroll again — with the rail scrolled off the top. */}
      <div className="flex min-h-0 flex-1">
        <CategoryRail entries={railEntries} />

        {/* KEYED, so every catalogue navigation remounts this pane at scrollTop
            0. The pane owns the scrolling in viewport mode, and Next resets the
            DOCUMENT's scroll on a navigation — which no longer reaches in here.
            React would otherwise reuse this unkeyed div across the press and
            keep its scrollTop: 下一页 from the bottom of page 1 landed at the
            BOTTOM of page 2. The RAIL beside it is deliberately NOT keyed — its
            scroll position is where the customer left the category column and
            has to survive the press; `rail-autoscroll.tsx` only nudges the lit
            entry into view, once, on mount. */}
        <div
          key={`${tab}|${activeCategory?.erp_code ?? ""}|${page}`}
          className="min-w-0 flex-1 overflow-y-auto bg-surface"
        >
          {/* Sticky inside the pane, not the page: it names the filter the rail
              set, counts what came back, and lets the customer choose between
              the original one-product-per-row view and the photo-led grid. */}
          <CatalogViewSwitcher
            paneLabel={paneLabel}
            count={t("paneCount", { n: count ?? 0 })}
            viewModeLabel={t("viewMode")}
            listLabel={t("listView")}
            gridLabel={t("gridView")}
            list={products.length === 0 ? emptyState : productList}
            grid={products.length === 0 ? emptyState : productGrid}
          />

          {totalPages > 1 && (
            // NAMED: this page carries three `<nav>` landmarks (the rail, the
            // tab bar, and this), and an unlabelled one is a bare "navigation"
            // in a screen reader's landmark list.
            <nav
              aria-label={t("pagerLabel")}
              className="flex items-center justify-center gap-2 py-4 text-sm"
            >
              {/* Two anchors at the bottom of a fifty-row list, thumbed on a
                  phone: 44px tall and padded wide enough to hit without aiming.
                  Outlined now, because on a bare white pane the card edge that
                  used to frame them as controls is gone. */}
              {page > 1 && (
                <Link
                  className="inline-flex h-11 items-center rounded-lg border border-border-strong px-3 text-brand-ink transition-colors hover:bg-brand-soft"
                  href={href({ page: page - 1 })}
                >
                  {t("prev")}
                </Link>
              )}
              <span className="px-2 font-num text-muted tabular-nums">
                {t("pageOf", { page, total: totalPages })}
              </span>
              {page < totalPages && (
                <Link
                  className="inline-flex h-11 items-center rounded-lg border border-border-strong px-3 text-brand-ink transition-colors hover:bg-brand-soft"
                  href={href({ page: page + 1 })}
                >
                  {t("next")}
                </Link>
              )}
            </nav>
          )}

          {/* Scroll room under the last row for the two bars that float over
              this pane on a phone — the ONLY reservation either of them gets,
              since both are fixed and neither is in anyone's flow.

              Both bars are anchored on the SAFE AREA, so this tail has to be
              too. `layout.tsx` asks for `viewport-fit=cover`, which is what
              makes `env(safe-area-inset-bottom)` report a real number (34px on
              a notched iPhone, 0 on everything else — call it S). The tab bar
              is 1px of hairline + a 56px row + S of padding, so its top edge is
              57 + S up from the glass; the demand bar sits at
              `calc(3.5rem + S + 0.5rem)` = 64 + S and is 50px tall, so ITS top
              edge is 114 + S (`tab-bar.tsx`, `cart/cart-bar.tsx`). A tail of a
              fixed 112px never cleared that: even at S = 0 a flush star box
              sat 2px under the bar, and on a notched phone (S = 34) the row's
              box fell 36px short. 7.5rem + S
              is 120 + S, which is 6px clear of 114 + S at EVERY inset.

              7.5rem and not 7rem, i.e. the row's own `py-2.5` is not clearance
              and cannot be spent here: the star's hit box is 36px with
              `-my-2.5` on it (`product-row.tsx`), so on a row with a two-line
              name and no price line — the shape every row takes while the
              owner's price switch is off — the box's bottom edge lands flush
              with the row's own bottom edge. The tail is the whole margin
              there, and 112 + S would put a pressable star under the bar.

              Desktop has neither bar and keeps a small tail so the list does not
              end flush against the window. */}
          <div
            aria-hidden
            className="h-[calc(7.5rem+env(safe-area-inset-bottom))] lg:h-8"
          />
        </div>
      </div>
    </AppShell>
  );
}
