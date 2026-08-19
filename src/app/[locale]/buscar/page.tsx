import type { Locale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { SearchIcon } from "@/components/icons";
import { ProductRow } from "@/components/product-row";
import { beginCompanyUser, finishCompanyUser } from "@/lib/auth/guards";
import { sanitizeSearch } from "@/lib/catalog/display";
import { perfRun } from "@/lib/perf";
import { getSetting } from "@/lib/settings";
import type { CustomerCatalogProduct } from "@/lib/supabase/public.types";
import { SearchHistory } from "./search-history";

export const dynamic = "force-dynamic";

/** The catalogue's page, so a long result set pages the way the catalogue does. */
const PAGE_SIZE = 50;

/**
 * 搜索 — the whole of searching, on its own screen.
 *
 * The catalogue used to carry a search form beside its filters, and the box at
 * the top of it is a LINK here now: a phone screen that searches has to own the
 * keyboard, the recent terms and the result list at once, and a second search UI
 * living inside the catalogue would be a second thing to keep in step with this
 * one (see the note on the link in `catalogo/page.tsx`).
 *
 * **The URL is the search.** `?q` is the entire state — typed and submitted,
 * pressed as a history chip, shared, bookmarked or reached with the back button,
 * all of it is the same GET — which is why the form below has no client
 * JavaScript on it at all. The one browser-owned piece is the history list, and
 * it is a leaf (`search-history.tsx`).
 *
 * With no `?q` the screen is the field and the chips: no query is issued and no
 * results section is rendered, because "everything" is what the catalogue is
 * for.
 */
export default async function SearchPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: Locale }>;
  searchParams: Promise<{ q?: string; page?: string }>;
}) {
  const { locale } = await params;
  const { q: rawQ, page: rawPage } = await searchParams;
  setRequestLocale(locale);
  const perf = perfRun(`/${locale}/buscar`);
  const { supabase, pendingUser } = await beginCompanyUser(locale);
  const t = await getTranslations("search");
  // The pager is the catalogue's, wording included: 上一页 / 下一页 / 第 n 页 are
  // the same three strings about the same fifty-row list, and a second copy of
  // them under `search.*` would be two places to translate one control.
  const tCatalog = await getTranslations("catalog");

  // Whatever the customer typed, made safe to embed in a PostgREST `or()`
  // pattern — the parser's own punctuation is stripped rather than escaped, and
  // the length is capped. It is also what the field is redrawn with and what the
  // history stores, so the term on the chip is the term that was searched.
  const q = sanitizeSearch(rawQ ?? "");
  const page = Math.max(1, Number.parseInt(rawPage ?? "1", 10) || 1);

  // ROUND ONE. The result page needs NOTHING from the restaurant's profile —
  // `?q` and `?page` are the whole query — so it goes on the wire BESIDE the
  // guard rather than behind it. `perf.step` subscribes the moment it is handed
  // the builder (see the note in `perf.ts`), which is what puts the request in
  // flight here and lets the page await it a round later. `show_prices` rides
  // along as it does on every page: the setting must never cost a round trip.
  //
  // Customers read the priced VIEW only: it carries exactly one price column,
  // resolved server-side from this company's tarifa. The three patterns are the
  // catalogue's old search unchanged — a codart read off a delivery note, and
  // the product name in either language, because a restaurant orders in Chinese
  // from a supplier whose data is Spanish.
  const from = (page - 1) * PAGE_SIZE;
  const pendingProducts = q
    ? perf.step(
        "products",
        supabase
          .from("products_priced")
          .select("*", { count: "exact" })
          .eq("is_current_variant", true)
          .or(`codart.ilike.%${q}%,name->>zh.ilike.%${q}%,name->>es.ilike.%${q}%`)
          .order("codart", { ascending: true })
          .range(from, from + PAGE_SIZE - 1),
      )
    : null;

  const [portalUser, showPrices] = await Promise.all([
    finishCompanyUser(pendingUser, locale),
    perf.step("settings", getSetting(supabase, "show_prices")),
  ]);

  // ROUND TWO. The favourites are the one read that needed the profile — they
  // are keyed by the restaurant's company. The gate is `pendingProducts`: a
  // query was ISSUED, not rows came back. A search that matches nothing still
  // pays this round trip, deliberately — the rows are not here yet to be
  // counted, and waiting for them to decide would cost every search that DOES
  // match a third round trip to draw its stars. A bare `/buscar` issues neither
  // query: it is a field and a list of words, and it costs the database nothing.
  const pendingFavorites = pendingProducts
    ? perf.step(
        "favorites",
        supabase
          .from("favorites")
          .select("product_id")
          .eq("company_id", portalUser.company_id),
      )
    : null;

  const [productsResult, favResult] = await Promise.all([
    pendingProducts,
    pendingFavorites,
  ]);

  if (productsResult?.error) console.error("search query:", productsResult.error);
  if (favResult?.error) console.error("search favorites query:", favResult.error);
  // A failed favourites read means no stars, never a broken page.
  const favoriteIds = new Set((favResult?.data ?? []).map((r) => r.product_id));

  const products: CustomerCatalogProduct[] = productsResult?.data ?? [];
  const count = productsResult?.count ?? 0;
  const totalPages = Math.max(1, Math.ceil(count / PAGE_SIZE));
  perf.end();

  // Every link out of the pager carries the search with it: `?page` alone would
  // walk the customer off their own query and onto page two of nothing.
  const href = (p: number) => {
    const sp = new URLSearchParams({ q });
    if (p > 1) sp.set("page", String(p));
    return `/${locale}/buscar?${sp.toString()}`;
  };

  // A `?page` past the end lands on the real last page instead of an empty list
  // under a non-zero count — the shape a bookmarked page 3 takes once the ERP
  // re-import shrinks what this `?q` matches. The count arrives on the SAME
  // response as the rows, so the clamp is known here for free and the extra
  // round trip is paid only in the rare over-range case. `href` is reused so the
  // query keeps this page's own encoding.
  if (page > totalPages) redirect(href(totalPages));

  // What the phone's bottom bar is allowed to add up: the CAJA price this render
  // resolved for each row it can actually order — the same figure the row shows,
  // because the cart's quantities are cajas too. A cart line that is not on this
  // page (or has no price, or has stopped being orderable) is missing from the
  // map, and the bar answers with a count instead of a wrong total.
  //
  // With the owner's switch OFF the map is not built at all: a page that
  // deliberately shows no prices has no business shipping the visible tarifa
  // down to the browser inside its RSC payload.
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

  return (
    <AppShell
      locale={locale}
      user={{ name: portalUser.display_name ?? portalUser.companies.name }}
      cartPrices={cartPrices}
      showPrices={showPrices}
    >
      {/* The screen names itself for a screen reader and nothing else: on glass
          the field IS the title — a heading above it would push the one control
          this page exists for further from the thumb — but the document still
          needs a top-level name, and every heading below this one is a section
          of it. */}
      <h1 className="sr-only">{t("title")}</h1>

      {/* One WHITE sheet, full-bleed. `layout="page"` insets `<main>` by 16px
          and leaves the beige ground showing, which is right for the portal's
          card pages and wrong for this one: the design draws search as a single
          white surface whose rules run edge to edge — the hairline under the
          history block, the one on top of every result row. So the sheet takes
          the gutter back with `-mx-4` and each block below pays its own.
          `min-h-dvh` is for the screen this page is MOST often on: a bare
          `/buscar`, opened from the catalogue's search box, is a field and
          nothing else, and a sheet only as tall as that field ends in a hard
          beige edge 141px down the phone that reads as a page which failed to
          load (the shell's header is 61px — `py-2` around a 44px icon row, plus
          its hairline — and this sheet is 80px: 4 above the field, its 40, 12
          below it, and the 24px tail). It costs an empty screen the ability to be flicked ~125px (the
          shell's header plus `<main>`'s own bottom inset) past its content; the
          alternative was subtracting those two by hand here, which is a number
          about the SHELL and would go stale inside it. */}
      <div className="-mx-4 min-h-dvh bg-surface">
        {/* A plain GET form, submitting to this same page. Enter (the phone
            keyboard's 搜索 key) is what submits it, and the result is an
            ordinary navigation to `?q=…` — no handler, no state, and the back
            button walks back through the searches. `role="search"` is the
            landmark that names this row for a screen reader; there is exactly
            one on the page, so it needs no label of its own. */}
        <form
          action={`/${locale}/buscar`}
          role="search"
          className="flex items-center gap-2.5 px-4 pt-1 pb-3"
        >
          <div className="relative flex min-w-0 flex-1 items-center">
            {/* The loupe is INSIDE the field's left padding and decorative: the
                input beside it is the real control and carries the accessible
                name. Absolute rather than a flex sibling, so it cannot take
                width from the text and the input can keep its own border — the
                field IS the input here, not a box drawn around one.

                16px, the same glyph at the same size as the box on the
                catalogue that links here (`catalogo/page.tsx`), so the two read
                as one control across the navigation. `icons.tsx` fixes 24px on
                the SVG itself; the arbitrary variant outranks it. */}
            <span
              aria-hidden
              className="pointer-events-none absolute top-1/2 left-3 flex -translate-y-1/2 text-brand [&>svg]:size-4"
            >
              <SearchIcon />
            </span>
            <input
              name="q"
              defaultValue={q}
              // The screen exists to be typed into, and it is only ever reached
              // by pressing something that says 搜索. React renders the real
              // `autofocus` attribute, so the caret is in the box as the
              // browser parses the page — no effect, no client component.
              autoFocus
              aria-label={t("placeholder")}
              placeholder={t("placeholder")}
              // 1.5px of brand, not the quiet `FIELD` border: this is the one
              // control on the screen, and the design draws it lit.
              //
              // The two paddings are not the field's own 12px because two
              // things sit inside it: `pl-9` clears the loupe (12px in, 16px
              // wide), and the right side only makes room for the × when there
              // IS one. `pr-8` is 32px, one pixel clear of the circle: the 44px
              // target is pinned `right-0` and centres its 18px circle, so the
              // circle runs from 31px to 13px in from the field's right edge.
              className={`h-10 flex-1 rounded-[10px] border-[1.5px] border-brand bg-surface pl-9 text-sm placeholder:text-faint focus:outline-none ${
                q ? "pr-8" : "pr-3"
              }`}
            />
            {/* The way OUT of a query, and only there when there is one. A LINK
                to the bare screen rather than a button that empties the field:
                clearing a search is a navigation like every other state change
                here, so the back button still holds the search that was just
                cleared. 18px of circle inside a 44px target — the target
                overhangs the 40px field by 2px at each end, into the row's own
                padding, which is what buys the thumb its full square.

                Its own string, not the history block's 清除: a screen reader
                meets these two controls one after the other, and "清除" twice on
                one screen names neither of the things it empties. */}
            {q && (
              <Link
                href={`/${locale}/buscar`}
                aria-label={t("clearSearch")}
                className="absolute top-1/2 right-0 flex size-11 -translate-y-1/2 items-center justify-center"
              >
                <span
                  aria-hidden
                  className="flex size-[18px] items-center justify-center rounded-full bg-border-strong text-[12px] leading-none text-white"
                >
                  ×
                </span>
              </Link>
            )}
          </div>

          {/* 取消 leaves the screen the way it was entered — back to the
              catalogue — and it is a link, not `history.back()`, because this
              page is also reachable from a bookmark and a shared URL. 44px
              square minimum around two characters. */}
          <Link
            href={`/${locale}/catalogo`}
            className="flex h-11 min-w-11 shrink-0 items-center justify-center px-1 text-sm text-ink-soft transition-colors hover:text-ink"
          >
            {t("cancel")}
          </Link>
        </form>

        <SearchHistory locale={locale} q={q} />

        {/* No `?q`, no results section at all — not an empty one. The screen is
            then the field and the chips, and there is nothing to say about a
            search nobody has made yet. */}
        {q && (
          <>
            <div className="flex items-baseline gap-2 px-4 pt-3.5 pb-2">
              <h2 className="text-[13.5px] font-bold">{t("results")}</h2>
              {/* The query's own exact count, so it is the size of the WHOLE
                  result set and not of this page of it. `font-num` puts the
                  numeral in Archivo; the CJK around it falls back to the body
                  stack glyph by glyph, as it does on the catalogue's counter. */}
              <span className="font-num text-[11.5px] text-faint tabular-nums">
                {t("resultCount", { n: count })}
              </span>
            </div>

            {products.length === 0 ? (
              // No "clear filters" link under this one: there is exactly one
              // filter on this screen, the × in the field is it, and it is
              // already on the row above.
              <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
                <span className="flex size-12 items-center justify-center rounded-full bg-border-strong text-muted">
                  <SearchIcon />
                </span>
                <p className="text-muted">{t("empty")}</p>
              </div>
            ) : (
              // Bare, as on the catalogue: the rows carry their own insets and
              // their own top rule (see `components/product-row.tsx`), which is
              // what makes the hairline between two of them full-bleed.
              <ul>
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
              <nav className="flex items-center justify-center gap-2 py-4 text-sm">
                {/* Two anchors at the bottom of a fifty-row list, thumbed on a
                    phone: 44px tall and padded wide enough to hit without
                    aiming. The catalogue's pager, with the search in the href. */}
                {page > 1 && (
                  <Link
                    className="inline-flex h-11 items-center rounded-lg border border-border-strong px-3 text-brand-ink transition-colors hover:bg-brand-soft"
                    href={href(page - 1)}
                  >
                    {tCatalog("prev")}
                  </Link>
                )}
                <span className="px-2 font-num text-muted tabular-nums">
                  {tCatalog("pageOf", { page, total: totalPages })}
                </span>
                {page < totalPages && (
                  <Link
                    className="inline-flex h-11 items-center rounded-lg border border-border-strong px-3 text-brand-ink transition-colors hover:bg-brand-soft"
                    href={href(page + 1)}
                  >
                    {tCatalog("next")}
                  </Link>
                )}
              </nav>
            )}
          </>
        )}

        {/* The design's 24px tail: the sheet does not end flush against its last
            row. What floats OVER it is the old red cart bar, which reserves its
            own 80px in the flow (`cart-bar.tsx`) — Task 5 replaces that pair. */}
        <div aria-hidden className="h-6" />
      </div>
    </AppShell>
  );
}
