import type { Locale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import Link from "next/link";
import { setProductCategory } from "@/app/actions/staff-products";
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
import { createAdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/database.types";

export const dynamic = "force-dynamic";

/**
 * Rows per page.
 *
 * It also bounds the heaviest thing this page renders, which is not the rows:
 * every row carries a `<select>` offering the WHOLE category list, so the option
 * nodes are `PAGE_SIZE × (CATEGORY_LIMIT + 1)` in the worst case and
 * 50 × (61 + 未分类) = 3,100 today, plus the 63 in the filter select above the
 * table — 3,163 on a full page.
 *
 * MEASURED against the real 61-category seed, in the browser: those 3,100 row
 * options are 126.3 KiB of zh markup and 138.5 KiB of es (the Spanish names are
 * longer), 128.8 / 141.3 KiB with the filter select's own 63. It compresses to
 * near nothing — the whole document is 823 KiB zh / 877 KiB es raw and 53 / 63
 * KiB gzipped — because it is the same 61 strings repeated fifty times, which is
 * exactly what a sliding window is for. The ceiling is what matters: this cost
 * is `PAGE_SIZE × CATEGORY_LIMIT` and moves only when one of those two does.
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
 * Exactly the columns this page renders. The six price columns are readable only
 * through the service-role client — authenticated holds no column privilege on
 * them — which is why the query below is an admin query, and why it runs only
 * after `requireStaff`.
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
  searchParams: Promise<{ q?: string; page?: string; cat?: string }>;
}) {
  const { locale } = await params;
  const { q: rawQ, page: rawPage, cat: rawCat } = await searchParams;
  setRequestLocale(locale);
  const perf = perfRun(`/${locale}/staff/productos`);
  // Sequential on purpose: the queries below are on the SERVICE-ROLE client —
  // the six price tiers are reachable no other way — so they run only once the
  // guard has said this caller is staff.
  const { staffUser } = await requireStaff(locale);
  const t = await getTranslations("staff");
  // Shared catalog vocabulary — control labels, the weighed badge, the pager,
  // and 全部, which means here exactly what it means on the customer's rail:
  // every category. Reused rather than duplicated into the staff namespace.
  const tCatalog = await getTranslations("catalog");

  const q = sanitizeSearch(rawQ ?? "");
  const page = Math.max(1, Number.parseInt(rawPage ?? "1", 10) || 1);
  const catParam = rawCat ?? "";

  const admin = createAdminClient();

  const productsQuery = (filter: CatFilter) => {
    let query = admin
      .from("products")
      .select(
        "id, codart, name, unit, units_per_case, is_weighed, is_available, image_url, category_id, price_1_cents, price_2_cents, price_3_cents, price_4_cents, price_5_cents, price_6_cents",
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
      admin
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
          admin.from("products").select("id", { count: "exact", head: true }),
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

  // THE order — the customer's rail sorts with this same function, so the chips
  // here, the options in every row's select and the rail a restaurant scrolls
  // cannot drift apart (see `lib/categories.ts`).
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

  /**
   * The label of ONE row's current filing, for the `title` on its select.
   *
   * Built off a Map rather than a `find` per row: 50 rows against 61 categories
   * is 3,050 comparisons a page for a lookup that is a hash. It resolves against
   * the SAME list the options are drawn from, so an id past `CATEGORY_LIMIT`
   * misses here exactly as it misses there and both fall back to 未分类 —
   * whatever the box shows, the tooltip says.
   */
  const categoryById = new Map(categories.map((c) => [c.id, c]));
  const filingLabel = (categoryId: number | null) => {
    const category = categoryId === null ? null : categoryById.get(categoryId);
    return category ? optionLabel(category) : t("uncategorized");
  };

  /**
   * The category list as the customer's rail reads it — 一级 headings with
   * their 二级 rows under them — rendered into BOTH selects as `<optgroup>`s.
   * Same derivation (`groupCategories`, same locale) as the rail, so the
   * grouping a staff member files under is the grouping a restaurant scrolls.
   *
   * Two arrays because the two selects speak different values: the filter
   * posts `erp_code` (the URL's word) and the per-row form posts the id (the
   * column's word) — the same split the shipped selects already documented.
   * Built ONCE and reused: the per-row copy appears 50 times a page, and a
   * React element is an immutable description, not a mounted node.
   */
  const grouped = groupCategories(categories, locale);
  const categoryOptions = (value: (c: (typeof categories)[number]) => string | number) =>
    grouped.map((entry) =>
      entry.kind === "group" ? (
        <optgroup key={`g:${entry.label}`} label={entry.label}>
          {entry.children.map((category) => (
            <option key={category.id} value={value(category)}>
              {optionLabel(category)}
            </option>
          ))}
        </optgroup>
      ) : (
        <option key={entry.category.id} value={value(entry.category)}>
          {optionLabel(entry.category)}
        </option>
      ),
    );
  const filterOptions = categoryOptions((category) => category.erp_code);
  const rowOptions = categoryOptions((category) => category.id);

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
              reader nine unrelated boxes per row. The mockup's rhythm is kept —
              its column widths, its 42px header, its 64px rows.

              Every `<th>` takes `scope="col"`. This is the app's only real data
              table, so the semantics are written out rather than left to a
              browser's heuristic: `scope` is what associates each cell with its
              header, and it is what lets a screen reader announce 分类 before
              reading the select in that column. */}
          <table className="w-full min-w-[900px] text-sm">
            <thead>
              <tr className="border-b border-[#EDE9E5] bg-field text-[11.5px] text-muted">
                <th scope="col" className={`${TH} pl-[18px]`}>
                  {t("colProduct")}
                </th>
                {/* 220px: the 140px select, the 6px gap and the 保存 beside it,
                    inside the cell's own 24px of padding. A HINT, not a rule —
                    the table is `table-layout: auto`, so the browser gives the
                    column what its content needs and takes it off the flexible
                    商品 column: measured at 1280 it settles at 220 in zh and 232
                    in es, where the button reads «Guardar», and the card still
                    does not clip. */}
                <th scope="col" className={`${TH} w-[220px]`}>
                  {t("colCategory")}
                </th>
                <th scope="col" className={`${TH} w-[110px]`}>
                  {t("colSpec")}
                </th>
                <th scope="col" className={`${TH} w-[110px]`}>
                  {t("colStatus")}
                </th>
                {/* A count, so it is aligned as one — with its column. */}
                <th scope="col" className={`${TH} w-[120px] text-right`}>
                  {t("colPrices")}
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
                  className={`${TH} relative w-[230px] pr-[18px] text-right`}
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
                        <div className="min-w-0">
                          <p className="text-[13.5px] font-semibold">{name}</p>
                          {/* The meta line, per the mockup: the ERP's own word
                              for the code it prints on every document. `SKU` is
                              left untranslated deliberately — it is the same
                              three letters in both of this portal's languages,
                              and the mockup's Chinese screen prints it too.
                              What used to ride here and no longer does is the
                              unit: it has a column of its own now (规格). */}
                          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted">
                            <span className="font-num">SKU {p.codart}</span>
                            {p.is_weighed && (
                              <span className="rounded-md bg-amber-100 px-1.5 py-0.5 text-amber-800">
                                {tCatalog("weighed")}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    </td>

                    {/* THE feature. One form per row, an explicit 保存, and no
                        client leaf: every mutation on this page is a form POST,
                        and a select that submitted on `change` would fire a
                        write per option as a keyboard user arrows through the
                        62.

                        BOTH controls are named after the product now. The select
                        always was; the button was not, so a screen reader met
                        fifty controls that all announced 「保存」 and nothing
                        else — the same list of identical buttons `roleFor` /
                        `saveRoleFor` already fixed on `/staff/usuarios`, and the
                        pair is copied from there. */}
                    <td className={ADMIN_TD}>
                      <form
                        action={setProductCategory}
                        className="flex items-center gap-1.5"
                      >
                        <input type="hidden" name="product_id" value={p.id} />
                        <select
                          name="category"
                          // The row's own filing, or 未分类. A `category_id`
                          // pointing past `CATEGORY_LIMIT` would have no option
                          // to select and the browser would fall back to the
                          // first one — unreachable at 61 categories against a
                          // bound of 500, and the bound is shared so that stays
                          // true. `filing` above resolves against the same list,
                          // so the title agrees with whatever the box shows.
                          defaultValue={
                            p.category_id === null ? "" : String(p.category_id)
                          }
                          aria-label={t("categoryFor", { name })}
                          // The FULL filing, on hover and on focus, because the
                          // box cannot hold it.
                          //
                          // The width arithmetic, MEASURED in the browser at
                          // 12.5px: the control's chrome is 38.5px — 2px of
                          // border, 16px of `FIELD_SM` padding and the ~20.5px
                          // Chromium reserves for the native dropdown arrow — so
                          // a 140px box shows 101.5px of text and the 104px this
                          // shipped as showed 65.5px. «Especial restaurante
                          // tailandés» is the longest name in the 61-row freepos
                          // seed (30 characters, 167.5px), and 140px shows 17 of
                          // them ("Especial restaura") where 104px showed 11
                          // ("Especial re") — a name cut before its own noun,
                          // and no room at all for the （已隐藏） marker a hidden
                          // category carries at the END of its label. Chinese
                          // advances a flat 12.5px per glyph, so ~8 fit.
                          //
                          // The pixels stop there: the column is 220px and the
                          // 保存 beside it is the rest of them. Seventeen
                          // characters is enough to TELL two filings apart, which
                          // is what the column is scanned for; what recovers the
                          // whole label is this title, and the OPEN dropdown,
                          // which every browser lays out at the width of its
                          // longest option rather than the width of the box.
                          title={filing}
                          className={`${FIELD_SM} w-[140px] text-[12.5px]`}
                        >
                          <option value="">{t("uncategorized")}</option>
                          {rowOptions}
                        </select>
                        <button
                          type="submit"
                          aria-label={t("saveCategoryFor", { name })}
                          className={`${BTN_QUIET} whitespace-nowrap`}
                        >
                          {t("saveCategory")}
                        </button>
                      </form>
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

                    <td
                      className={`${ADMIN_TD} text-right font-num text-[12.5px] tabular-nums`}
                    >
                      {pricedTiers(p)}/6
                    </td>

                    {/* ONE control, where four used to be (owner, 2026-08-21:
                        「右侧按钮太多」). 停售 and 称重 became checkboxes on the
                        editor, 设为当前 stopped existing with the variant
                        groups, and everything the row could not fix at all —
                        the name, the photo, the SKU — is a click away. */}
                    <td className={`${ADMIN_TD} pr-[18px] text-right`}>
                      <Link
                        href={`/${locale}/staff/productos/${p.id}`}
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
