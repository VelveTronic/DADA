import type { Locale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import Link from "next/link";
import {
  setCurrentVariant,
  setProductAvailability,
  setProductCategory,
  setProductWeighed,
} from "@/app/actions/staff-products";
import { ProductThumb } from "@/components/product-thumb";
import { StaffShell } from "@/components/staff-shell";
import { BTN_QUIET, FIELD_SM } from "@/components/ui";
import { requireStaff } from "@/lib/auth/guards";
import { localizedName, sanitizeSearch, unitLabel } from "@/lib/catalog/display";
import { CATEGORY_LIMIT, sortCategories } from "@/lib/categories";
import { perfRun } from "@/lib/perf";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/database.types";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

/**
 * How many categories get a chip before the rest are left to the select beside
 * them.
 *
 * Seven, and the eighth control on the row is 全部. The mockup draws six chips
 * on a 1440 frame; ours are drawn in the ~990px this page's column is wide at
 * 1280 (max-w-5xl inside the 240px sidebar), so eight fit on one line with the
 * 230px search box beside them and wrap to a second when a category name is
 * long. There are 61 categories: a chip each would be a wall, and the `<select>`
 * that follows is the whole list — including the hidden ones and 未分类, which
 * no chip offers.
 */
const CHIP_LIMIT = 7;

/**
 * The admin card. `#EDE9E5` is NOT a token because it appears only on /staff:
 * it is the mockup's own hairline for the back office, a shade darker than the
 * customer card's `--color-border` (#f2eeea), and promoting it would put a
 * second "border" in the palette that no customer screen may use. Same for the
 * 12px radius — `rounded-card` (14px) is the customer card and stays theirs.
 * Stated once on `/staff/categorias` (:54) when that page shipped; repeated here
 * because this is the second and last screen that draws one today.
 */
const ADMIN_CARD = "rounded-xl border border-[#EDE9E5] bg-surface";

/**
 * A filter chip. The mockup's active state is its ink swatch with white
 * letters, which is the token map's `bg-ink text-white font-semibold`; the
 * resting one is the house's quiet control, the same border and hover the row
 * buttons carry so the row reads as one family.
 */
const CHIP = "inline-flex h-[30px] items-center rounded-lg px-3 text-[12.5px]";
const CHIP_ON = `${CHIP} bg-ink font-semibold text-white`;
const CHIP_OFF = `${CHIP} border border-border-strong bg-surface text-ink-soft transition-colors hover:border-brand hover:text-brand-ink`;

/**
 * The header row, per the mockup: 42px tall, on the `field` shade (its `#FBFAF9`
 * IS that token), 11.5px muted. `text-muted` and not the mockup's `#8C857E`,
 * which is the standing AA rule for table headers — a sole-carrier label is
 * read, so it clears 4.5:1.
 */
const TH = "h-[42px] px-3 text-left align-middle font-medium";
const TD = "px-3 py-2.5 align-middle";

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
  | "base_sku"
  | "variant_suffix"
  | "is_current_variant"
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

/**
 * What `?cat=` resolved to: no filter at all, the products nobody filed, or one
 * category's id.
 *
 * `null` is also where an `erp_code` that matches no category lands — the
 * customer catalogue's own precedent for an unknown `?cat=` (`catalogo/page.tsx`
 * resolves it "to nothing and the page renders unfiltered, never a failed
 * query"), and the same rule keeps a stale bookmark from emptying this table.
 */
type CatFilter = { kind: "none" } | { kind: "id"; id: number } | null;

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
        "id, codart, base_sku, variant_suffix, is_current_variant, name, unit, units_per_case, is_weighed, is_available, image_url, category_id, price_1_cents, price_2_cents, price_3_cents, price_4_cents, price_5_cents, price_6_cents",
        { count: "exact" },
      );
    if (q) {
      query = query.or(
        `codart.ilike.%${q}%,base_sku.ilike.%${q}%,name->>zh.ilike.%${q}%,name->>es.ilike.%${q}%`,
      );
    }
    // The two halves of the 分类 filter. `none` is the one the owner actually
    // needs: it is how a product the freepos import filed nowhere is FOUND, and
    // it is why the select beside the chips offers a value no chip does.
    if (filter?.kind === "none") query = query.is("category_id", null);
    if (filter?.kind === "id") query = query.eq("category_id", filter.id);
    const from = (page - 1) * PAGE_SIZE;
    return query
      .order("base_sku")
      .order("variant_suffix")
      .range(from, from + PAGE_SIZE - 1);
  };

  /**
   * Whether the products query has to WAIT for the category list.
   *
   * Only one `?cat=` value does: an `erp_code`, which is a word about a row
   * this page has not read yet. `` (no filter) and the literal `none` are
   * answered without knowing a single category, so on an ordinary load — and on
   * the 未分类 view — the products go out beside the categories rather than
   * behind them, and the page costs the one round trip it always cost.
   */
  const needsCategories = catParam !== "" && catParam !== "none";

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
        .select("id, erp_code, name, sort_order, is_active")
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
    needsCategories ? null : perf.step("products", productsQuery(null)),
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
   * `?cat=` is an `erp_code`, exactly as it is on the customer catalogue — one
   * filter vocabulary for both halves of the portal, so a staff member can paste
   * a restaurant's URL into this page. The one word that is not a code is the
   * literal `none`.
   */
  const activeCategory = needsCategories
    ? (categories.find((c) => c.erp_code === catParam) ?? null)
    : null;
  const catFilter: CatFilter =
    catParam === "none"
      ? { kind: "none" }
      : activeCategory
        ? { kind: "id", id: activeCategory.id }
        : null;

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

  // Page-local group sizes. base_sku ordering keeps a variant group contiguous,
  // so the count is exact except for a group split across a page boundary.
  const groupSizes = new Map<string, number>();
  for (const p of products) {
    groupSizes.set(p.base_sku, (groupSizes.get(p.base_sku) ?? 0) + 1);
  }

  /**
   * Every link on this page, carrying the state it is not changing.
   *
   * `q` always rides along — narrowing a search to a category must not throw the
   * search away — and a chip resets the pager, because page 7 of 全部 is not a
   * page of anything once a category is picked. An unknown `erp_code` is dropped
   * rather than echoed: the table below it is unfiltered, so the pager must not
   * claim otherwise (the catalogue's `activeCategory?.erp_code ?? ""` rule).
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

  // Chips are the ACTIVE categories only — a chip is a shortcut to a view a
  // restaurant also has, and the hidden ones live in the select beside them
  // where the （已隐藏） marker can explain what they are.
  const chipCategories = categories
    .filter((c) => c.is_active)
    .slice(0, CHIP_LIMIT);

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

      <div className="mt-5 flex flex-wrap items-center gap-2.5">
        <Link href={href({ cat: "", page: 1 })} className={catFilter === null ? CHIP_ON : CHIP_OFF}>
          {tCatalog("railAll")}
        </Link>
        {chipCategories.map((category) => (
          <Link
            key={category.id}
            href={href({ cat: category.erp_code, page: 1 })}
            className={
              activeCategory?.id === category.id ? CHIP_ON : CHIP_OFF
            }
          >
            {category.label}
          </Link>
        ))}

        {/* The whole list, for the 54 categories with no chip — plus 未分类,
            which no chip offers and which is the entry point for the assignment
            work this page exists for. An explicit 筛选 button and no onChange
            submit: a select that navigates as the value changes is a keyboard
            trap (arrowing through the options fires a request per option), and
            this half of the portal ships no client JavaScript for its filters. */}
        <form method="get" className="flex items-center gap-2">
          {q && <input type="hidden" name="q" value={q} />}
          <select
            name="cat"
            defaultValue={settledCat}
            aria-label={t("filterCategory")}
            className={`${FIELD_SM} h-[34px] max-w-[190px] text-[12.5px]`}
          >
            <option value="">{tCatalog("railAll")}</option>
            <option value="none">{t("uncategorized")}</option>
            {categories.map((category) => (
              // The FILTER speaks the URL's language — `erp_code`, the same
              // word the customer catalogue's `?cat=` carries. The per-row
              // select further down speaks the COLUMN's, and posts an id.
              <option key={category.id} value={category.erp_code}>
                {optionLabel(category)}
              </option>
            ))}
          </select>
          <button type="submit" className={`${BTN_QUIET} h-[34px] shrink-0 whitespace-nowrap`}>
            {t("filterApply")}
          </button>
        </form>

        {/* The search keeps every mechanic it had — a GET form, `?q`,
            `sanitizeSearch` on both ends — and takes the mockup's 34px field.
            `cat` rides along hidden so searching inside a category stays inside
            it. `ml-auto` is the mockup's own `margin-left:auto`, and only once
            the row is wide enough to have any spare room. */}
        <form method="get" className="flex flex-1 items-center gap-2 sm:ml-auto sm:flex-none">
          {settledCat && <input type="hidden" name="cat" value={settledCat} />}
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
        </form>
      </div>

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
              its column widths, its 42px header, its 64px rows. */}
          <table className="w-full min-w-[900px] text-sm">
            <thead>
              <tr className="border-b border-[#EDE9E5] bg-field text-[11.5px] text-muted">
                <th className={`${TH} pl-[18px]`}>{t("colProduct")}</th>
                <th className={`${TH} w-[190px]`}>{t("colCategory")}</th>
                <th className={`${TH} w-[110px]`}>{t("colSpec")}</th>
                <th className={`${TH} w-[110px]`}>{t("colStatus")}</th>
                {/* A count, so it is aligned as one — with its column. */}
                <th className={`${TH} w-[120px] text-right`}>
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
                <th className={`${TH} relative w-[230px] pr-[18px] text-right`}>
                  <span className="sr-only">{t("colActions")}</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#F4F0EC]">
              {products.map((p) => {
                const groupSize = groupSizes.get(p.base_sku) ?? 1;
                const inGroup = groupSize > 1 || p.variant_suffix !== "";
                const name = localizedName(p.name, locale);
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
                    <td className={`${TD} pl-[18px]`}>
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

                    {/* THE feature. One form per row, an explicit 保存, and no
                        client leaf: every mutation on this page is a form POST,
                        and a select that submitted on `change` would fire a
                        write per option as a keyboard user arrows through 61 of
                        them. The `<select>` is named by the product it belongs
                        to, because 50 unlabelled selects in a column are 50
                        identical controls to a screen reader. */}
                    <td className={TD}>
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
                          // true.
                          defaultValue={
                            p.category_id === null ? "" : String(p.category_id)
                          }
                          aria-label={t("categoryFor", { name })}
                          className={`${FIELD_SM} w-[104px] text-[12.5px]`}
                        >
                          <option value="">{t("uncategorized")}</option>
                          {categories.map((category) => (
                            <option key={category.id} value={category.id}>
                              {optionLabel(category)}
                            </option>
                          ))}
                        </select>
                        <button
                          type="submit"
                          className={`${BTN_QUIET} whitespace-nowrap`}
                        >
                          {t("save")}
                        </button>
                      </form>
                    </td>

                    {/* The factor rides on the unit, exactly as the catalogue
                        prints it (`CAJA×24`, silent at 1): it is what multiplies
                        the tarifa price into the per-caja price a customer sees,
                        so staff comparing a price against the ERP need it on the
                        row. */}
                    <td className={`${TD} text-[12.5px] text-ink-soft`}>
                      {unitLabel(p.unit, p.units_per_case)}
                    </td>

                    <td className={TD}>
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span
                          className={
                            p.is_available ? CHIP_ON_SALE : CHIP_OFF_SALE
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

                    <td
                      className={`${TD} text-right font-num text-[12.5px] tabular-nums`}
                    >
                      {pricedTiers(p)}/6
                    </td>

                    <td className={`${TD} pr-[18px] text-right`}>
                      <div className="flex flex-wrap justify-end gap-2">
                        <form action={setProductAvailability}>
                          <input type="hidden" name="product_id" value={p.id} />
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
                            badge on the meta line is what it turns on. */}
                        <form action={setProductWeighed}>
                          <input type="hidden" name="product_id" value={p.id} />
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
