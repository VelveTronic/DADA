import type { Locale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import Link from "next/link";
import {
  moveCategoryAction,
  renameCategory,
  setCategoryActive,
} from "@/app/actions/staff-categories";
import { ProductThumb } from "@/components/product-thumb";
import { StaffShell } from "@/components/staff-shell";
import { BTN_PRIMARY, BTN_QUIET, FIELD_SM } from "@/components/ui";
import { beginStaff, finishStaff } from "@/lib/auth/guards";
import { localizedName } from "@/lib/catalog/display";
import type { CategoryError } from "@/lib/categories";
import {
  CATEGORY_ERRORS,
  isCategoryError,
  MAX_CATEGORY_NAME_LENGTH,
  sortCategories,
} from "@/lib/categories";
import { perfRun } from "@/lib/perf";
import { CreateCategoryForm } from "./create-category-form";

export const dynamic = "force-dynamic";

/**
 * 分类管理 — the rail the restaurants scroll, as a list a staff member can
 * reorder, rename, hide and add to.
 *
 * **Everything here rides the SESSION client.** Categories and products are both
 * fully readable by a staff session under RLS (`categories_read` and
 * `products_read` name `private.is_staff()` first), and the four writes behind
 * the buttons are the same — `public.categories` is the one table the hardening
 * round left open to an authenticated staff member, which is why this whole
 * feature needed no migration and no new RPC. The mechanism, with its migration
 * line numbers, is documented once in `app/actions/staff-categories.ts`.
 *
 * That is also why the reads below are RACED with the guard, the way
 * `/staff/pedidos` races its queue and unlike `/staff/productos`, which reads
 * price columns with the service-role client and must wait: a session read
 * answers under the caller's own RLS, so a request that turns out not to be
 * staff learns nothing it could not have read anyway — and `finishStaff`
 * redirects out of the `Promise.all` before a row is rendered.
 */

/**
 * The admin card. `#EDE9E5` is NOT a token because it appears only on /staff:
 * it is the mockup's own hairline for the back office, a shade darker than the
 * customer card's `--color-border` (#f2eeea), and promoting it would put a
 * second "border" in the palette that no customer screen may use. Same for the
 * 12px radius — `rounded-card` (14px) is the customer card and stays theirs.
 */
const ADMIN_CARD = "rounded-xl border border-[#EDE9E5] bg-surface";

/** The card's own head rule, in the same one-off shade. */
const CARD_HEAD =
  "flex items-center justify-between border-b border-[#EDE9E5] px-[18px] py-3.5 text-[13px] font-bold";

/**
 * A list row. `#F4F0EC` is the existing row rule (`product-row.tsx:104`) — the
 * hairline BETWEEN rows, lighter than the card's edge — and `#FCFBFA` is the
 * admin pane wash from the mockup, used here as the hover tint. Neither is a
 * token: both appear only where a list is drawn on white, and the palette
 * already carries `surface-dim` for the tints that are shared with the
 * storefront.
 */
const ROW = "flex items-center gap-3 border-t border-[#F4F0EC] px-[18px] py-[13px]";

/**
 * The ↑/↓ pair. 32px targets, which is the mockup's admin control size and the
 * floor this portal uses for a button that sits inside a row (the catalogue's
 * stepper squares are the same 32). Disabled at the ends of the list rather than
 * hidden, so the column does not reflow row by row.
 */
const MOVE_BTN =
  "inline-flex size-8 items-center justify-center rounded-lg border border-border-strong bg-surface text-xs leading-none text-ink-soft transition-colors hover:border-brand hover:text-brand-ink disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-border-strong disabled:hover:text-ink-soft";

/**
 * How many categories this page will draw. 61 today — the whole freepos tree
 * (`scripts/seed-categories.ts`) — and the rail is hand-managed, so this is a
 * guard against a runaway list, not a pager.
 */
const CATEGORY_LIMIT = 500;

/**
 * How far the per-category product count reads.
 *
 * ONE read for every count: `select category_id` for the whole products table
 * and a tally in memory. The alternative is a `head:true` count per category,
 * which is 61 round trips for one page. 5,000 is above the 2,971 products the
 * freepos import loaded, and `count: "exact"` on the same request is what makes
 * a future overrun VISIBLE — the page logs it rather than quietly under-counting
 * the tail of the list.
 */
const PRODUCT_SCAN_LIMIT = 5000;

/** How many products the detail pane lists before it says how many are left. */
const DETAIL_LIMIT = 50;

export default async function StaffCategoriesPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: Locale }>;
  searchParams: Promise<{ cat?: string; result?: string; new?: string }>;
}) {
  const { locale } = await params;
  const {
    cat: rawCat,
    result: rawResult,
    new: rawNew,
  } = await searchParams;
  setRequestLocale(locale);
  const perf = perfRun(`/${locale}/staff/categorias`);
  const { supabase, pendingStaff } = await beginStaff(locale);
  const t = await getTranslations("staff.categories");

  // The actions redirect with `?result=<CODE>`. The parameter is user-editable,
  // so it is proved to be one of the known codes BEFORE it is used as a message
  // key — a raw value would render as whatever the URL said.
  const raw = rawResult ?? "";
  const result: "ok" | CategoryError | null =
    raw === "ok" || isCategoryError(raw) ? raw : null;
  const creating = rawNew === "1";

  // ROUND ONE. Neither read needs anything from the guard, so both go out beside
  // it. The counts read is the whole `category_id` column, tallied below.
  const [staffUser, categoryResult, productScan] = await Promise.all([
    finishStaff(pendingStaff, locale),
    perf.step(
      "categories",
      supabase
        .from("categories")
        .select("id, erp_code, name, parent_label, sort_order, is_active")
        .limit(CATEGORY_LIMIT),
    ),
    perf.step(
      "counts",
      supabase
        .from("products")
        .select("category_id", { count: "exact" })
        .range(0, PRODUCT_SCAN_LIMIT - 1),
    ),
  ]);

  if (categoryResult.error) {
    console.error("staff categories query:", categoryResult.error);
  }
  if (productScan.error) {
    console.error("staff categories product scan:", productScan.error);
  }
  const scanned = productScan.data ?? [];
  if ((productScan.count ?? 0) > scanned.length) {
    // Not a page error — the counts are simply low for whatever the scan did not
    // reach, and the operator is the one who can raise the bound.
    console.error(
      `staff categories product scan truncated at ${scanned.length} of ${productScan.count}`,
    );
  }
  /**
   * Products per category, counted from the one scan. Every row filed under the
   * category, which is the ERP's own filing — not what a restaurant sees, since
   * the catalogue also hides discontinued variants. The detail list below counts
   * the same way, so the two figures on this page always agree.
   */
  const counts = new Map<number, number>();
  for (const row of scanned) {
    if (row.category_id == null) continue;
    counts.set(row.category_id, (counts.get(row.category_id) ?? 0) + 1);
  }
  const countOf = (id: number) => counts.get(id) ?? 0;

  // THE order — the customer's rail sorts with this same function, so this list
  // and that one cannot drift apart (see `lib/categories.ts`).
  const categories = sortCategories(categoryResult.data ?? [], locale);

  /**
   * `?cat=` here is the category's ID, not the `erp_code` the CUSTOMER catalogue
   * filters on: this page shows categories the rail does not (hidden ones), and
   * the id is what its four actions post. An unknown value selects the first
   * category rather than an empty pane, exactly as the catalogue resolves an
   * unknown `?cat=` to no filter at all.
   */
  const selected =
    categories.find((row) => String(row.id) === rawCat) ?? categories[0] ?? null;

  // ROUND TWO, and only for the pane on the right. It cannot join round one: on
  // a bare `/staff/categorias` the category it reads is "the first one in rail
  // order", which is not known until the list above has been read and sorted.
  const detail = selected
    ? await perf.step(
        "categoryProducts",
        supabase
          .from("products")
          .select("id, codart, name, image_url")
          .eq("category_id", selected.id)
          .order("codart")
          .limit(DETAIL_LIMIT),
      )
    : null;
  perf.end();
  if (detail?.error) {
    console.error("staff categories products query:", detail.error);
  }
  const detailProducts = detail?.data ?? [];

  /**
   * The customer's rail draws ACTIVE categories only, so the position a staff
   * member is told about is the position among those — on a list where three of
   * the first ten are hidden, "第 7 位" counted over every row would name a slot
   * no restaurant has.
   */
  const activePosition =
    selected && selected.is_active
      ? categories.filter((row) => row.is_active).findIndex((row) => row.id === selected.id) + 1
      : 0;

  /**
   * The OTHER language's name, for the small line under the big one — and only
   * when there is one. `localizedName` falls back across locales, so a zh-only
   * category would otherwise print its Chinese name twice.
   */
  const secondName = (name: unknown) => {
    const other = localizedName(name, locale === "zh" ? "es" : "zh");
    return other && other !== localizedName(name, locale) ? other : null;
  };

  /**
   * One key of the name jsonb, RAW — no locale fallback.
   *
   * The rename fields must show what is stored, not what is displayed: prefilled
   * with the fallback, saving a zh-only category would silently copy its Chinese
   * name into the Spanish key and it could never fall back again.
   */
  const rawName = (name: unknown, key: "zh" | "es") => {
    if (!name || typeof name !== "object" || Array.isArray(name)) return "";
    const value = (name as Record<string, unknown>)[key];
    return typeof value === "string" ? value : "";
  };

  /**
   * Links inside the page keep the two pieces of view state — which category is
   * open, and whether the create card is out — and deliberately drop `?result=`:
   * a banner answers the press that produced it and must not survive a click on
   * the next row.
   */
  const pageHref = (next: { cat?: number | string; create?: boolean }) => {
    const sp = new URLSearchParams();
    const cat =
      next.cat === undefined ? (selected ? String(selected.id) : "") : String(next.cat);
    if (cat) sp.set("cat", cat);
    if (next.create ?? creating) sp.set("new", "1");
    const query = sp.toString();
    return `/${locale}/staff/categorias${query ? `?${query}` : ""}`;
  };

  // A rejected create answers the FORM with a code instead of redirecting, so
  // the form needs the same sentences this page's banner uses. Built from the
  // closed list rather than a handful of literals: a new code gets a message
  // there the moment it exists, exactly as `messages.test.ts` requires.
  const errorLabels = Object.fromEntries(
    CATEGORY_ERRORS.map((code) => [code, t(`results.${code}`)]),
  ) as Record<CategoryError, string>;

  const selectedLabel = selected?.label ?? "";
  const selectedSecond = selected ? secondName(selected.name) : null;
  const groupLabel = selected ? localizedName(selected.parent_label, locale) : "";

  return (
    <StaffShell
      locale={locale}
      title={t("title")}
      breadcrumb={t("title")}
      user={{
        name: staffUser.display_name ?? staffUser.id,
        role: staffUser.role,
      }}
    >
      <div className="mt-2 flex flex-wrap items-end justify-between gap-4">
        <p className="max-w-xl text-[13px] text-muted">{t("subtitle")}</p>
        {/* The mockup's header CTA. A LINK, not a disclosure button: the create
            card is a view of this page like the selected category is, so it
            survives a reload and can be sent to somebody. It keeps one shape and
            one word — the way OUT of the card is the 取消 on the card itself,
            beside the fields it discards, and a corner control that changed size
            under the cursor would be the alternative. */}
        <Link href={pageHref({ create: true })} className={BTN_PRIMARY}>
          {t("newButton")}
        </Link>
      </div>

      {result && (
        <p
          role={result === "ok" ? "status" : "alert"}
          className={`mt-4 rounded-lg px-3 py-2 text-sm ${
            result === "ok"
              ? "bg-green-50 text-green-800"
              : "bg-red-50 text-red-700"
          }`}
        >
          {t(`results.${result}`)}
        </p>
      )}

      {/* `items-start` so the detail card keeps its own height instead of
          stretching down the whole 61-row list beside it. */}
      <div className="mt-5 grid items-start gap-[18px] lg:grid-cols-[340px_1fr]">
        <section className={`${ADMIN_CARD} overflow-hidden`}>
          <h2 className={CARD_HEAD}>
            {t("listHead")}
            <span className="font-num font-medium text-muted tabular-nums">
              {categories.length}
            </span>
          </h2>

          {categories.length === 0 ? (
            <p className="px-[18px] py-10 text-center text-sm text-muted">
              {t("emptyList")}
            </p>
          ) : (
            /* Scrolls INSIDE the card at lg, where the detail pane is beside it:
               61 rows is ~2,900px, and without this the pane on the right would
               sit at the top of a column the staff member has to scroll back up
               to. Below lg the two cards are stacked, and the page scrolls. */
            <ul className="lg:max-h-[calc(100vh-13rem)] lg:overflow-y-auto">
              {categories.map((category, index) => {
                const isSelected = selected?.id === category.id;
                const second = secondName(category.name);
                return (
                  <li
                    key={category.id}
                    // `first:border-t-0` so the top row's rule does not double up
                    // with the card head's own.
                    className={`${ROW} first:border-t-0 ${
                      isSelected
                        ? "bg-brand-soft text-brand-ink"
                        : "hover:bg-[#FCFBFA]"
                    }`}
                  >
                    {/* Two forms, not one with two submit buttons: the direction
                        travels as a hidden field, and a form whose meaning
                        depends on WHICH button was pressed is a form that means
                        nothing when the browser submits it with Enter. */}
                    <div className="flex flex-none items-center gap-0.5">
                      {(["up", "down"] as const).map((dir) => (
                        <form key={dir} action={moveCategoryAction}>
                          <input type="hidden" name="locale" value={locale} />
                          <input type="hidden" name="id" value={category.id} />
                          <input type="hidden" name="dir" value={dir} />
                          <input
                            type="hidden"
                            name="cat"
                            value={selected?.id ?? ""}
                          />
                          <button
                            type="submit"
                            disabled={
                              dir === "up"
                                ? index === 0
                                : index === categories.length - 1
                            }
                            // One ↑ per row would tell a screen reader nothing
                            // about which category it moves.
                            aria-label={t(dir === "up" ? "moveUp" : "moveDown", {
                              name: category.label,
                            })}
                            className={MOVE_BTN}
                          >
                            <span aria-hidden>{dir === "up" ? "↑" : "↓"}</span>
                          </button>
                        </form>
                      ))}
                    </div>

                    <Link
                      href={pageHref({ cat: category.id })}
                      aria-current={isSelected ? "page" : undefined}
                      className="flex min-w-0 flex-1 items-center gap-2"
                    >
                      <span className="min-w-0 flex-1">
                        <span
                          className={`block truncate text-[13.5px] ${
                            isSelected ? "font-bold" : ""
                          }`}
                        >
                          {category.label}
                        </span>
                        {second && (
                          <span className="block truncate text-[11px] text-muted">
                            {second}
                          </span>
                        )}
                      </span>
                      {!category.is_active && (
                        <span className="flex-none rounded-md bg-surface-dim px-1.5 py-0.5 text-[11px] text-muted">
                          {t("hiddenChip")}
                        </span>
                      )}
                      <span className="flex-none font-num text-xs text-muted tabular-nums">
                        {t("productCount", { n: countOf(category.id) })}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <div className="flex flex-col gap-[18px]">
          {creating && (
            <section className={ADMIN_CARD}>
              <div className={CARD_HEAD}>
                <h2>{t("newTitle")}</h2>
                <Link href={pageHref({ create: false })} className={BTN_QUIET}>
                  {t("newCancel")}
                </Link>
              </div>
              <div className="px-[18px] py-4">
                <CreateCategoryForm
                  locale={locale}
                  labels={{
                    nameZh: t("nameZh"),
                    nameEs: t("nameEs"),
                    submit: t("newSubmit"),
                    hiddenCopy: t("newHiddenCopy"),
                    ok: t("newOk"),
                  }}
                  errorLabels={errorLabels}
                />
              </div>
            </section>
          )}

          {selected && (
            <>
              <section className={ADMIN_CARD}>
                <div className="border-b border-[#EDE9E5] px-5 py-4">
                  <h2 className="text-base font-bold">{selectedLabel}</h2>
                  {selectedSecond && (
                    <p className="mt-0.5 text-xs text-muted">{selectedSecond}</p>
                  )}
                  <p className="mt-1.5 text-xs text-muted">
                    {activePosition > 0
                      ? t("positionLine", {
                          n: countOf(selected.id),
                          i: activePosition,
                        })
                      : t("positionHidden", { n: countOf(selected.id) })}
                  </p>
                  {groupLabel && (
                    // `parent_label` is a display grouping the freepos tree
                    // carried, NOT a hierarchy (there is no parent id), so it is
                    // shown and never edited here.
                    <p className="mt-1.5 text-xs text-muted">
                      {t("groupLabel")}: {groupLabel}
                    </p>
                  )}
                </div>

                <div className="flex flex-col gap-5 px-5 py-4">
                  {/* KEYED by the category it is editing. An uncontrolled input
                      keeps whatever the DOM holds across a re-render, so without
                      this, clicking the next row in the list would leave the
                      PREVIOUS category's name sitting in the field — and saving
                      would rename the wrong one. Same lesson as the keyed select
                      in `usuarios/create-customer-form.tsx`. */}
                  <form
                    key={selected.id}
                    action={renameCategory}
                    className="grid gap-3 sm:grid-cols-2"
                  >
                    <input type="hidden" name="locale" value={locale} />
                    <input type="hidden" name="id" value={selected.id} />
                    <input type="hidden" name="cat" value={selected.id} />
                    <label className="flex flex-col gap-1 text-xs text-muted">
                      {t("nameZh")}
                      <input
                        name="name_zh"
                        maxLength={MAX_CATEGORY_NAME_LENGTH}
                        autoComplete="off"
                        defaultValue={rawName(selected.name, "zh")}
                        className={`${FIELD_SM} text-ink`}
                      />
                    </label>
                    <label className="flex flex-col gap-1 text-xs text-muted">
                      {t("nameEs")}
                      <input
                        name="name_es"
                        maxLength={MAX_CATEGORY_NAME_LENGTH}
                        autoComplete="off"
                        defaultValue={rawName(selected.name, "es")}
                        className={`${FIELD_SM} text-ink`}
                      />
                    </label>
                    <div className="sm:col-span-2">
                      <button
                        type="submit"
                        aria-label={t("renameFor", { name: selectedLabel })}
                        className={BTN_QUIET}
                      >
                        {t("rename")}
                      </button>
                    </div>
                  </form>

                  <div className="flex flex-wrap items-center gap-3 border-t border-[#F4F0EC] pt-4">
                    <form action={setCategoryActive}>
                      <input type="hidden" name="locale" value={locale} />
                      <input type="hidden" name="id" value={selected.id} />
                      <input type="hidden" name="cat" value={selected.id} />
                      <input
                        type="hidden"
                        name="active"
                        value={selected.is_active ? "0" : "1"}
                      />
                      <button
                        type="submit"
                        aria-label={t(
                          selected.is_active ? "hideFor" : "showFor",
                          { name: selectedLabel },
                        )}
                        className={BTN_QUIET}
                      >
                        {selected.is_active ? t("hide") : t("show")}
                      </button>
                    </form>
                    {/* What the press actually does, beside the button that does
                        it: hiding takes the rail entry away and leaves the
                        products reachable under 全部. */}
                    <p className="min-w-0 flex-1 text-xs text-muted">
                      {selected.is_active ? t("hideCopy") : t("showCopy")}
                    </p>
                  </div>
                </div>
              </section>

              <section className={`${ADMIN_CARD} overflow-hidden`}>
                <h2 className={CARD_HEAD}>
                  {t("productsHead")}
                  <span className="font-num font-medium text-muted tabular-nums">
                    {countOf(selected.id)}
                  </span>
                </h2>

                {detailProducts.length === 0 ? (
                  <p className="px-[18px] py-10 text-center text-sm text-muted">
                    {t("emptyProducts")}
                  </p>
                ) : (
                  <ul>
                    {detailProducts.map((product) => (
                      <li
                        key={product.id}
                        className={`${ROW} first:border-t-0`}
                      >
                        <ProductThumb src={product.image_url} />
                        <span className="min-w-0 flex-1 truncate text-[13px]">
                          {localizedName(product.name, locale)}
                        </span>
                        <span className="flex-none font-num text-[11px] text-muted tabular-nums">
                          {product.codart}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}

                {countOf(selected.id) > detailProducts.length && (
                  // Read-only, and deliberately not a pager: assigning a product
                  // to a category is the PRODUCTS page's job, and this list is
                  // here to say what is in the category before it is hidden.
                  <p className="border-t border-[#F4F0EC] px-[18px] py-3 text-xs text-muted">
                    {t("moreProducts", {
                      n: countOf(selected.id) - detailProducts.length,
                    })}
                  </p>
                )}
              </section>
            </>
          )}
        </div>
      </div>
    </StaffShell>
  );
}
