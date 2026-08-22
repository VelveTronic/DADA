import type { Locale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import Link from "next/link";
import { ProductThumb } from "@/components/product-thumb";
import { StaffShell } from "@/components/staff-shell";
import { ADMIN_CARD, ADMIN_TD, BTN_QUIET, FIELD_SM } from "@/components/ui";
import { requireStaff } from "@/lib/auth/guards";
import { localizedName, sanitizeSearch, unitLabel } from "@/lib/catalog/display";
import {
  CAT_NONE,
  type CatFilter,
  CATEGORY_LIMIT,
  catNeedsCategories,
  groupCategories,
  resolveCatFilter,
  sortCategories,
} from "@/lib/categories";
import { perfRun } from "@/lib/perf";
import type { Database } from "@/lib/supabase/database.types";
import { createServerSupabase } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * Rows per page. Category assignment is read-only on this list; editing happens
 * on the product page, so the table no longer repeats the full category select
 * fifty times.
 */
const PAGE_SIZE = 50;

/*
 * There is no chip row above the table any more (owner, 2026-08-20): seven
 * default category chips crowded the filter select off its line, and the
 * select — grouped 一级/二级 below — is the whole list anyway.
 */

/**
 * The header row, per the mockup: 42px tall, on the `field` shade (its `#FBFAF9`
 * IS that token), 11.5px muted. `text-muted` and not the mockup's `#8C857E`,
 * which is the standing AA rule for table headers — a sole-carrier label is
 * read, so it clears 4.5:1.
 *
 * Stays local for that height: the dashboard's mini table heads its rows at
 * `h-10`, so the two header strings differ and there is nothing to share. The
 * body cell is shared — `ADMIN_TD` in `components/ui.ts`, byte-identical on
 * both pages.
 */
const TH = "h-[42px] px-3 text-left align-middle font-medium";

/*
 * The two shades this table draws rows with, both already named on
 * `/staff/categorias` (:58-65, on its `ROW`) and neither a token:
 *
 *  - `#F4F0EC` — the rule BETWEEN rows (`divide-y` on the tbody below),
 *    lighter than `ADMIN_CARD`'s own edge. It is the existing product-row rule,
 *    `product-row.tsx:104`, so a list of products is ruled the same on both
 *    halves of the portal.
 *  - `#FCFBFA` — the mockup's admin pane wash, used on the row hover.
 *
 * Neither is promoted because both appear only where a LIST is drawn on white,
 * and the palette already carries `surface-dim` for the tints the storefront
 * shares.
 */

/**
 * 可售 / 停售, as the mockup's two table chips.
 *
 * The green pair is the `albaran` chip's, hex for hex — `order-status-badge.tsx`
 * gives it as `bg-[#F0F4F0] text-[#4A6A4E]` and the mockup calls the same swatch
 * `done` (5.5:1, AA at chip size). It is COPIED rather than imported because
 * that map is keyed by order status and a product is not an order; what the two
 * share is the palette, not the state machine. 停售 is the token map's `off`,
 * and that one is real tokens.
 *
 * The words are the shipped staff pair 可售/停售 (`available`/`unavailable`),
 * NOT the customer catalogue's 断货 — same column, two audiences, and decision 2
 * keeps the staff word on the staff screen.
 */
const CHIP_BASE =
  "inline-flex shrink-0 items-center rounded-md px-2 py-1 text-xs font-semibold";
const CHIP_ON_SALE = `${CHIP_BASE} bg-[#F0F4F0] text-[#4A6A4E]`;
const CHIP_OFF_SALE = `${CHIP_BASE} bg-surface-dim text-muted`;

/**
 * Exactly the columns this page renders. Prices deliberately stay out of this
 * list; their read-only Wingest snapshot remains available in the editor.
 */
type StaffProductRow = Pick<
  Database["public"]["Tables"]["products"]["Row"],
  | "id"
  | "codart"
  | "name"
  | "unit"
  | "units_per_case"
  | "is_weighed"
  | "is_available"
  | "image_url"
  | "category_id"
>;

export default async function StaffProductsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: Locale }>;
  searchParams: Promise<{ q?: string; page?: string; cat?: string }>;
}) {
  const { locale } = await params;
  const { q: rawQ, page: rawPage, cat: rawCat } = await searchParams;
  setRequestLocale(locale);
  const perf = perfRun(`/${locale}/staff/productos`);
  // The session guard completes before the catalogue reads; all selected
  // columns are staff-readable under RLS and no service-role client is needed.
  const { staffUser } = await requireStaff(locale);
  const t = await getTranslations("staff");
  // Shared catalog vocabulary — control labels, the weighed badge, the pager,
  // and 全部, which means here exactly what it means on the customer's rail:
  // every category. Reused rather than duplicated into the staff namespace.
  const tCatalog = await getTranslations("catalog");

  const q = sanitizeSearch(rawQ ?? "");
  const page = Math.max(1, Number.parseInt(rawPage ?? "1", 10) || 1);
  const catParam = rawCat ?? "";

  const supabase = await createServerSupabase();

  const productsQuery = (filter: CatFilter) => {
    let query = supabase
      .from("products")
      .select(
        "id, codart, name, unit, units_per_case, is_weighed, is_available, image_url, category_id",
        { count: "exact" },
      );
    if (q) {
      // `base_sku` left the search with the variant groups (2026-08-21): it is
      // a copy of `codart` on every row now, so a second ILIKE over it would
      // scan the same strings twice for the same hits.
      query = query.or(
        `codart.ilike.%${q}%,name->>zh.ilike.%${q}%,name->>es.ilike.%${q}%`,
      );
    }
    // The two halves of the 分类 filter. `none` is the one the owner actually
    // needs: it is how a product the freepos import filed nowhere is FOUND, and
    // it is why the select beside the chips offers a value no chip does.
    if (filter?.kind === "none") query = query.is("category_id", null);
    if (filter?.kind === "id") query = query.eq("category_id", filter.id);
    const from = (page - 1) * PAGE_SIZE;
    // By SKU, which is the order staff read a catalogue in and — since the
    // variant dissolution — the only order there is: `base_sku`/`variant_suffix`
    // are `codart` and "" on every row, so the old two-key sort said the same
    // thing in three columns.
    return query.order("codart").range(from, from + PAGE_SIZE - 1);
  };

  /**
   * Whether the products query has to WAIT for the category list.
   *
   * Only one `?cat=` value does: an `erp_code`, which is a word about a row
   * this page has not read yet. `` (no filter) and the literal `none` are
   * answered without knowing a single category, so on an ordinary load — and on
   * the 未分类 view — the products go out beside the categories rather than
   * behind them, and the page costs the one round trip it always cost.
   *
   * The question is asked of `lib/categories.ts` rather than answered here, and
   * that is the whole repair: this page used to carry its own copy of the rule
   * and then race a hard-coded `productsQuery(null)` beside it, so `?cat=none`
   * was resolved correctly, ignored completely, and rendered the entire table
   * under a 未分类 select.
   */
  const needsCategories = catNeedsCategories(catParam);

  /**
   * The filter as it is known BEFORE a single category has been read.
   *
   * The empty list is not a placeholder — it IS this render's state of knowledge
   * at this line, and `resolveCatFilter` answers it under exactly the rules it
   * will answer the real list with. When `needsCategories` is false the function
   * never looks at the list at all, so this value is provably the same one the
   * table is later rendered under (`categories.test.ts` asserts that identity),
   * and the raced query below cannot filter differently from the page around it.
   */
  const eagerCatFilter = resolveCatFilter(catParam, []);

  /**
   * The unfiltered size of the table, for the sub-line under the title.
   *
   * Only when something is filtered, and decided on the RAW inputs — before
   * `?cat=` has been resolved — because the decision has to be made while the
   * requests are being put on the wire. A mistyped `erp_code` therefore buys one
   * wasted HEAD request and answers with the same number the main query's own
   * `count` carries; an ordinary load buys nothing at all.
   */
  const wantsTotal = q !== "" || catParam !== "";

  // ONE round for everything that can share it (see `needsCategories`).
  const [categoryResult, totalResult, racedProducts] = await Promise.all([
    perf.step(
      "categories",
        supabase
        .from("categories")
        .select("id, erp_code, name, parent_label, sort_order, is_active")
        // The same bound and the same order as `/staff/categorias` and the move
        // action read under (`CATEGORY_LIMIT`, imported rather than retyped):
        // an unordered `limit` may hand back a different subset per request, and
        // a category this page offered but the list page never saw would be a
        // 分类 option whose row nobody can rename. 500 is comfortably under
        // PostgREST's 1000-row cap, so this is one request and not a scan.
        .order("id")
        .limit(CATEGORY_LIMIT),
    ),
    wantsTotal
      ? perf.step(
          "total",
          supabase.from("products").select("id", { count: "exact", head: true }),
        )
      : null,
    needsCategories
      ? null
      : perf.step("products", productsQuery(eagerCatFilter)),
  ]);

  if (categoryResult.error) {
    console.error("staff products categories query:", categoryResult.error);
  }
  if (totalResult?.error) {
    console.error("staff products total count:", totalResult.error);
  }

  // THE order — shared by the filter, read-only table labels and customer rail.
  const categories = sortCategories(categoryResult.data ?? [], locale);

  /**
   * `?cat=` resolved for real, now that the list is in hand.
   *
   * Unconditional, and it has to be: when `needsCategories` was false this is
   * the same value as `eagerCatFilter` by construction (the list is untouched on
   * that branch), so the `racedProducts ??` short-circuit below hands back a
   * slice that was queried under THIS filter and not some other one. When it was
   * true, no race happened and this is the first and only resolution.
   */
  const catFilter: CatFilter = resolveCatFilter(catParam, categories);

  const { data, count, error } =
    racedProducts ?? (await perf.step("products", productsQuery(catFilter)));
  perf.end();
  if (error) console.error("staff products query:", error);
  const products: StaffProductRow[] = data ?? [];
  const totalPages = Math.max(1, Math.ceil((count ?? 0) / PAGE_SIZE));

  /**
   * The figure in the sub-line, in three cases and one expression.
   *
   * Nothing filtered: no HEAD count was made, and none was needed — the main
   * query carried `count: "exact"` under no predicate, so its count IS the size
   * of the table. Something filtered: the HEAD count is that size, and the main
   * query's count is the size of the SLICE, which the pager already prints.
   * The HEAD count failed: fall back to the filtered count, which reads low, and
   * the log line above is what says so.
   */
  const totalProducts = totalResult?.count ?? count ?? 0;

  /**
   * Every link on this page, carrying the state it is not changing.
   *
   * `q` always rides along — narrowing a search to a category must not throw the
   * search away — and a chip resets the pager, because page 7 of 全部 is not a
   * page of anything once a category is picked. An unknown `erp_code` is dropped
   * rather than echoed: the table below it is unfiltered, so the pager must not
   * claim otherwise (the catalogue's own `activeCategory?.erp_code ?? ""` rule,
   * `catalogo/page.tsx:149` and `:288`).
   *
   * `null` is the ONE dropped case, so `?cat=none` — which resolves to a filter
   * — survives every link and the select's `defaultValue` alike.
   */
  const settledCat = catFilter === null ? "" : catParam;
  const href = (next: { cat?: string; page?: number }) => {
    const sp = new URLSearchParams();
    const cat = next.cat ?? settledCat;
    if (q) sp.set("q", q);
    if (cat) sp.set("cat", cat);
    if ((next.page ?? 1) > 1) sp.set("page", String(next.page));
    const s = sp.toString();
    return `/${locale}/staff/productos${s ? `?${s}` : ""}`;
  };

  /**
   * One option label: the category's name, marked when it is off the rail.
   *
   * The marker is `staff.categoryHidden` and not `staff.categories.hiddenChip`
   * by reference, even though both print the same word: a suffix is punctuation
   * as well as vocabulary, and the two languages do not agree about it —
   * 「（已隐藏）」 takes full-width parentheses and Spanish takes " (oculta)",
   * lower-cased because it is mid-phrase rather than a chip of its own.
   */
  const optionLabel = (category: { label: string; is_active: boolean }) =>
    category.is_active
      ? category.label
      : t("categoryHidden", { name: category.label });

  /** One row's read-only category label, resolved in constant time. */
  const categoryById = new Map(categories.map((c) => [c.id, c]));
  const filingLabel = (categoryId: number | null) => {
    const category = categoryId === null ? null : categoryById.get(categoryId);
    return category ? optionLabel(category) : t("uncategorized");
  };

  /** The same 一级/二级 grouping the customer category navigation uses. */
  const grouped = groupCategories(categories, locale);
  const filterOptions = grouped.map((entry) =>
      entry.kind === "group" ? (
        <optgroup key={`g:${entry.label}`} label={entry.label}>
          {entry.children.map((category) => (
            <option key={category.id} value={category.erp_code}>
              {optionLabel(category)}
            </option>
          ))}
        </optgroup>
      ) : (
        <option
          key={entry.category.id}
          value={entry.category.erp_code}
        >
          {optionLabel(entry.category)}
        </option>
      ),
    );

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
      {/* The mockup's sub-line. The shell owns the h1, so this is the first
          thing the page itself puts under it. Two real figures: every product
          in the table (not the filtered slice — the pager prints that) and every
          category this page can file one under, hidden ones included, which is
          the list the selects below actually offer. The mockup's third clause,
          客户端不显示价格, is NOT here: it is a `show_prices` setting this page
          does not read, and A7 owns the screen that does. */}
      <p className="mt-2 text-[13px] text-muted">
        {t("productsSummary", { n: totalProducts, m: categories.length })}
      </p>

      {/* ONE form for BOTH controls, and that is a fix rather than a tidy-up.
          They were two GET forms, each carrying the other's settled value in a
          hidden field — so typing a new search and then pressing 筛选 sent the
          OLD `q` (the hidden copy this render was built from) and threw the
          typed one away, and picking a category and then pressing 搜索 did the
          mirror image. Merged, the browser sends whatever is in the two
          controls at the moment of the press, and no hidden fields are needed
          between them at all. (The pager still carries both, via `href` above —
          it is links, not this form.)

          BOTH submit buttons stay. They submit the SAME form and therefore the
          same pair of fields; neither carries a `name`, so nothing tells the
          server which one was pressed and nothing needs to. Two buttons rather
          than one because the mockup draws two, and because each names the
          control beside it for a keyboard user tabbing along the row.

          The select is the whole list — every category, 一级-grouped, hidden
          ones marked, plus 未分类, which is the entry point for the assignment
          work this page exists for. An explicit button and no onChange submit:
          a select that navigates as the value changes is a keyboard trap
          (arrowing through 63 options fires a request per option), and this
          half of the portal ships no client JavaScript for its filters. */}
      <form method="get" className="mt-5 flex flex-wrap items-center gap-2">
          <select
            name="cat"
            defaultValue={settledCat}
            aria-label={t("filterCategory")}
            className={`${FIELD_SM} h-[34px] max-w-[190px] text-[12.5px]`}
          >
            <option value="">{tCatalog("railAll")}</option>
            {/* The one option whose value is not an `erp_code`. It is
                collision-safe by the WRITERS and not by the schema — the column
                is plain unique text, so Postgres would take a category coded
                `none`, but neither writer can produce one: all 61 freepos codes
                are decimal digit strings (`scripts/seed-categories.ts`) and
                every portal-minted code is `p<epoch-ms>` (`makePortalErpCode`).
                Stated in full on `CAT_NONE`. */}
            <option value={CAT_NONE}>{t("uncategorized")}</option>
            {/* The FILTER speaks the URL's language — `erp_code`, the same
                word the customer catalogue's `?cat=` carries. The per-row
                select further down speaks the COLUMN's, and posts an id. */}
            {filterOptions}
          </select>
          <button type="submit" className={`${BTN_QUIET} h-[34px] shrink-0 whitespace-nowrap`}>
            {t("filterApply")}
          </button>

          {/* The search keeps every mechanic it had — `?q`, `sanitizeSearch` on
              both ends, the mockup's 34px field. `ml-auto` is the mockup's own
              `margin-left:auto`, and only once the row is wide enough to have
              any spare room; below that the pair takes the width it needs and
              wraps under the select. */}
          <div className="flex flex-1 items-center gap-2 sm:ml-auto sm:flex-none">
            <input
              name="q"
              defaultValue={q}
              aria-label={t("searchPlaceholder")}
              placeholder={t("searchPlaceholder")}
              className={`${FIELD_SM} h-[34px] w-full text-[12.5px] sm:w-[230px]`}
            />
            <button type="submit" className={`${BTN_QUIET} h-[34px] shrink-0 whitespace-nowrap`}>
              {tCatalog("searchButton")}
            </button>
          </div>
      </form>

      {products.length === 0 ? (
        <p className={`${ADMIN_CARD} mt-[18px] p-10 text-center text-muted`}>
          {tCatalog("noResults")}
        </p>
      ) : (
        /* `overflow-x-auto` on the CARD, so the table is what scrolls sideways
           on a phone-width drawer and the page body never does. */
        <div className={`${ADMIN_CARD} mt-[18px] overflow-x-auto`}>
          {/* A real `<table>`, not the mockup's div grid: this is tabular data
              with a header per column, and the grid version gives a screen
              reader unrelated boxes per row. The mockup's rhythm is kept —
              its column widths, its 42px header, its 64px rows.

              Every `<th>` takes `scope="col"`. This is the app's only real data
              table, so the semantics are written out rather than left to a
              browser's heuristic: `scope` is what associates each cell with its
              header, and it lets a screen reader announce 分类 before reading
              that row's category. */}
          <table className="w-full min-w-[820px] table-auto text-sm">
            <thead>
              <tr className="border-b border-[#EDE9E5] bg-field text-[11.5px] text-muted">
                {/* Product name is the only flexible column and owns the spare
                    desktop width; the operational fields keep compact bounds. */}
                <th scope="col" className={`${TH} min-w-[300px] pl-[18px]`}>
                  {t("colProduct")}
                </th>
                <th scope="col" className={`${TH} w-[135px] whitespace-nowrap`}>
                  {t("colSku")}
                </th>
                <th scope="col" className={`${TH} w-[190px]`}>
                  {t("colCategory")}
                </th>
                <th scope="col" className={`${TH} w-[105px]`}>
                  {t("colSpec")}
                </th>
                <th scope="col" className={`${TH} w-[105px]`}>
                  {t("colStatus")}
                </th>
                {/* Named for screen readers, blank on screen: the column holds
                    only buttons, which label themselves.
                    `relative` is not decoration. `sr-only` is
                    `position:absolute`, and with no positioned ancestor its
                    containing block is the page itself — so on a phone, where
                    the table is wider than the card scrolling it, this 1px span
                    was laid out 880px from the left edge of the DOCUMENT and
                    gave the whole page a horizontal scrollbar the card was
                    there to prevent. One `relative` puts it back inside its own
                    cell. */}
                <th
                  scope="col"
                  className={`${TH} relative w-[86px] pr-[18px] text-right`}
                >
                  <span className="sr-only">{t("colActions")}</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#F4F0EC]">
              {products.map((p) => {
                const name = localizedName(p.name, locale);
                const filing = filingLabel(p.category_id);
                return (
                  <tr
                    key={p.id}
                    // The dimming is the row's own signal that it is off sale,
                    // kept from the shipped table: the 停售 chip says it in
                    // words and this says it from across the room.
                    className={`transition-colors hover:bg-[#FCFBFA] ${
                      p.is_available ? "" : "opacity-50"
                    }`}
                  >
                    <td className={`${ADMIN_TD} pl-[18px]`}>
                      <div className="flex items-center gap-3">
                        <ProductThumb src={p.image_url} />
                        <div className="min-w-0 flex-1">
                          <p className="line-clamp-2 break-words text-[13.5px] font-semibold leading-5">
                            {name}
                          </p>
                          {p.is_weighed && (
                            <span className="mt-1 inline-flex rounded-md bg-amber-100 px-1.5 py-0.5 text-[11px] text-amber-800">
                              {tCatalog("weighed")}
                            </span>
                          )}
                        </div>
                      </div>
                    </td>

                    <td className={`${ADMIN_TD} font-num text-[12.5px] text-ink-soft`}>
                      <span className="whitespace-nowrap">{p.codart}</span>
                    </td>

                    {/* Read-only here: category changes join all other product
                        mutations on the dedicated editor and its single Save. */}
                    <td className={`${ADMIN_TD} text-[12.5px] text-ink-soft`}>
                      <span className="line-clamp-2" title={filing}>
                        {filing}
                      </span>
                    </td>

                    {/* The factor rides on the unit, exactly as the catalogue
                        prints it (`CAJA×24`, silent at 1): it is what multiplies
                        the tarifa price into the per-caja price a customer sees,
                        so staff comparing a price against the ERP need it on the
                        row. */}
                    <td className={`${ADMIN_TD} text-[12.5px] text-ink-soft`}>
                      {unitLabel(p.unit, p.units_per_case)}
                    </td>

                    <td className={ADMIN_TD}>
                      {/* One chip, not two: the 当前变体 badge beside it went
                          with the variant groups (2026-08-21). */}
                      <span
                        className={
                          p.is_available ? CHIP_ON_SALE : CHIP_OFF_SALE
                        }
                      >
                        {p.is_available ? t("available") : t("unavailable")}
                      </span>
                    </td>

                    {/* ONE control, where four used to be (owner, 2026-08-21:
                        「右侧按钮太多」). 停售 and 称重 became checkboxes on the
                        editor, 设为当前 stopped existing with the variant
                        groups, and everything the row could not fix at all —
                        the name, the photo, the SKU — is a click away. */}
                    <td className={`${ADMIN_TD} pr-[18px] text-right`}>
                      <Link
                        href={`/${locale}/staff/productos/${p.id}`}
                        aria-label={t("editFor", { name })}
                        className={BTN_QUIET}
                      >
                        {t("edit")}
                      </Link>
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
              href={href({ page: page - 1 })}
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
              href={href({ page: page + 1 })}
            >
              →
            </Link>
          )}
        </nav>
      )}
    </StaffShell>
  );
}
