import type { Locale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { updateProduct } from "@/app/actions/staff-products";
import { StaffShell } from "@/components/staff-shell";
import { ADMIN_CARD, BTN_PRIMARY, BTN_QUIET, FIELD_SM } from "@/components/ui";
import { requireStaff } from "@/lib/auth/guards";
import { CATALOG_IMAGE_ACCEPT } from "@/lib/catalog-image";
import { CATEGORY_LIMIT, groupCategories, sortCategories } from "@/lib/categories";
import { formatEuros } from "@/lib/money";
import { perfRun } from "@/lib/perf";
import {
  isProductEditResult,
  type ProductEditResult,
} from "@/lib/product-edit";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/**
 * 商品编辑 — the repair path the catalogue never had (owner, 2026-08-21).
 *
 * Every product in this portal arrived from the freepos import, and until now
 * the only things a staff member could change about one were three flags and
 * its category. A wrong name, a missing photo, a SKU that does not match the
 * ERP article it is supposed to be needed SQL. This page owns all of it, which
 * is also what let the list's row shrink back to ONE action button.
 *
 * **Service-role, like the list beside it.** `/staff/productos` reads the six
 * price columns, which are revoked from `authenticated` outright, so that page
 * runs on the admin client after `requireStaff` — and this one shows the same
 * prices (read-only, so a staff member editing a product can see what the ERP
 * says it costs) and writes with the same client. The five write-mechanism
 * lanes in this app do not mix; this is the products lane, both halves.
 */

/** The card's own head rule, in the same one-off shade as `ADMIN_CARD`. */
const CARD_HEAD =
  "border-b border-[#EDE9E5] px-5 py-3.5 text-[13px] font-bold";

/** A field label: the house's small muted caption over its control. */
const LABEL = "flex flex-col gap-1 text-xs text-muted";

/** The six tarifa columns, in tier order — read-only here. */
const PRICE_KEYS = [
  "price_1_cents",
  "price_2_cents",
  "price_3_cents",
  "price_4_cents",
  "price_5_cents",
  "price_6_cents",
] as const;

export default async function StaffProductEditPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: Locale; id: string }>;
  searchParams: Promise<{ result?: string }>;
}) {
  const { locale, id } = await params;
  const { result: rawResult } = await searchParams;
  setRequestLocale(locale);
  const perf = perfRun(`/${locale}/staff/productos/[id]`);
  // Sequential, exactly as the list page is: the guard answers first and the
  // reads follow, so a caller who turns out not to be staff never reaches them.
  // (Both pages dropped the service-role client on 2026-08-22 — neither reads
  // the six price columns any more.)
  const { staffUser } = await requireStaff(locale);
  const t = await getTranslations("staff");
  const tEdit = await getTranslations("staff.productEdit");

  // The action redirects with `?result=<CODE>`. User-editable, so it is proved
  // to be one of the known codes BEFORE it is used as a message key.
  const raw = rawResult ?? "";
  const result: ProductEditResult | null = isProductEditResult(raw) ? raw : null;

  const admin = createAdminClient();
  const [productResult, categoryResult] = await Promise.all([
    perf.step(
      "product",
      admin
        .from("products")
        .select(
          "id, codart, name, unit, units_per_case, is_available, is_weighed, image_url, category_id, price_1_cents, price_2_cents, price_3_cents, price_4_cents, price_5_cents, price_6_cents",
        )
        .eq("id", id)
        .maybeSingle(),
    ),
    perf.step(
      "categories",
      admin
        .from("categories")
        .select("id, erp_code, name, parent_label, sort_order, is_active")
        // The same bound and order every category read in this app shares.
        .order("id")
        .limit(CATEGORY_LIMIT),
    ),
  ]);
  perf.end();

  if (productResult.error) {
    console.error("staff product edit query:", productResult.error);
  }
  // A bad uuid reaches PostgREST as a 22P02 rather than an empty result, so
  // both the error and the miss land on the same 404 — the page cannot draw a
  // form for a product it does not have.
  const product = productResult.data;
  if (!product) notFound();

  if (categoryResult.error) {
    console.error("staff product edit categories:", categoryResult.error);
  }
  const categories = sortCategories(categoryResult.data ?? [], locale);
  const grouped = groupCategories(categories, locale);

  /**
   * One key of the name jsonb, RAW — no locale fallback, for the same reason
   * the category rename fields take it raw (`staff/categorias/page.tsx`):
   * prefilled with the fallback, saving a zh-only product would copy its
   * Chinese name into the Spanish key and it could never fall back again.
   */
  const rawName = (key: "zh" | "es") => {
    const name = product.name;
    if (!name || typeof name !== "object" || Array.isArray(name)) return "";
    const value = (name as Record<string, unknown>)[key];
    return typeof value === "string" ? value : "";
  };

  const optionLabel = (category: { label: string; is_active: boolean }) =>
    category.is_active
      ? category.label
      : t("categoryHidden", { name: category.label });

  return (
    <StaffShell
      locale={locale}
      title={tEdit("title")}
      breadcrumb={t("nav.products")}
      user={{
        name: staffUser.display_name ?? staffUser.id,
        role: staffUser.role,
      }}
    >
      <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
        <p className="font-num text-[13px] text-muted">SKU {product.codart}</p>
        <Link href={`/${locale}/staff/productos`} className={BTN_QUIET}>
          {tEdit("back")}
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
          {tEdit(`results.${result}`)}
        </p>
      )}

      {/* ONE form for the whole product. The file part is what makes it
          multipart, and Next 16 hands a Server Function the `File` itself —
          no upload endpoint, no client JavaScript on this page at all. */}
      <form action={updateProduct} className="mt-5 flex flex-col gap-[18px]">
        <input type="hidden" name="product_id" value={product.id} />
        <input type="hidden" name="locale" value={locale} />

        <section className={ADMIN_CARD}>
          <h2 className={CARD_HEAD}>{tEdit("basics")}</h2>
          <div className="grid gap-4 px-5 py-4 sm:grid-cols-2">
            <label className={LABEL}>
              {tEdit("nameZh")}
              <input
                name="name_zh"
                maxLength={200}
                autoComplete="off"
                defaultValue={rawName("zh")}
                className={`${FIELD_SM} text-ink`}
              />
            </label>
            <label className={LABEL}>
              {tEdit("nameEs")}
              <input
                name="name_es"
                maxLength={200}
                autoComplete="off"
                defaultValue={rawName("es")}
                className={`${FIELD_SM} text-ink`}
              />
            </label>

            <label className={`${LABEL} sm:col-span-2`}>
              {tEdit("codart")}
              <input
                name="codart"
                maxLength={30}
                required
                autoComplete="off"
                defaultValue={product.codart}
                className={`${FIELD_SM} font-num text-ink`}
              />
              {/* The warning is the point: this is the ERP join key, and a code
                  Wingest does not have costs the product its prices and its
                  orders their injection. */}
              <span className="text-[11px] text-muted">
                {tEdit("codartHint")}
              </span>
            </label>

            <label className={LABEL}>
              {tEdit("unit")}
              <input
                name="unit"
                maxLength={20}
                autoComplete="off"
                defaultValue={product.unit ?? ""}
                className={`${FIELD_SM} text-ink`}
              />
            </label>
            <label className={LABEL}>
              {tEdit("unitsPerCase")}
              <input
                name="units_per_case"
                type="number"
                min={1}
                step={1}
                defaultValue={product.units_per_case ?? 1}
                className={`${FIELD_SM} font-num text-ink`}
              />
            </label>

            <label className={`${LABEL} sm:col-span-2`}>
              {t("colCategory")}
              <select
                name="category"
                defaultValue={
                  product.category_id === null ? "" : String(product.category_id)
                }
                className={`${FIELD_SM} max-w-sm text-ink`}
              >
                <option value="">{t("uncategorized")}</option>
                {grouped.map((entry) =>
                  entry.kind === "group" ? (
                    <optgroup key={`g:${entry.label}`} label={entry.label}>
                      {entry.children.map((category) => (
                        <option key={category.id} value={category.id}>
                          {optionLabel(category)}
                        </option>
                      ))}
                    </optgroup>
                  ) : (
                    <option
                      key={entry.category.id}
                      value={entry.category.id}
                    >
                      {optionLabel(entry.category)}
                    </option>
                  ),
                )}
              </select>
            </label>

            {/* The two flags that used to be buttons on the list row. As
                checkboxes they are part of the same save, which is why the row
                could give up its cluster. */}
            <div className="flex flex-wrap gap-x-6 gap-y-2 text-[13px] sm:col-span-2">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  name="available"
                  value="1"
                  defaultChecked={product.is_available}
                  className="accent-brand"
                />
                {tEdit("available")}
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  name="weighed"
                  value="1"
                  defaultChecked={product.is_weighed}
                  className="accent-brand"
                />
                {tEdit("weighed")}
              </label>
            </div>
            <p className="text-[11px] text-muted sm:col-span-2">
              {tEdit("weighedHint")}
            </p>
          </div>
        </section>

        <section className={ADMIN_CARD}>
          <h2 className={CARD_HEAD}>{tEdit("photo")}</h2>
          <div className="flex flex-wrap items-start gap-5 px-5 py-4">
            {product.image_url ? (
              <Image
                src={product.image_url}
                alt=""
                width={96}
                height={96}
                className="size-24 shrink-0 rounded-lg border border-border bg-border object-cover"
              />
            ) : (
              <div className="size-24 shrink-0 rounded-lg border border-border bg-border" />
            )}
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <label className={LABEL}>
                {tEdit("photoNew")}
                <input
                  type="file"
                  name="image"
                  accept={CATALOG_IMAGE_ACCEPT}
                  className="text-[12.5px] text-ink file:mr-3 file:rounded-lg file:border file:border-border-strong file:bg-surface file:px-3 file:py-1.5 file:text-[12.5px] file:text-ink-soft"
                />
              </label>
              <span className="text-[11px] text-muted">
                {tEdit("photoHint")}
              </span>
            </div>
          </div>
        </section>

        <section className={ADMIN_CARD}>
          <h2 className={CARD_HEAD}>{tEdit("prices")}</h2>
          {/* READ-ONLY, and it has to be: the six tarifa columns are owned by
              the nightly price-sync, which rewrites them from the ERP. A field
              here would let a staff member type a price that survives until
              06:30 and then silently reverts. */}
          <div className="flex flex-wrap gap-x-6 gap-y-2 px-5 py-4 text-[12.5px]">
            {PRICE_KEYS.map((key, index) => {
              const cents = product[key];
              return (
                <span key={key} className="text-muted">
                  {tEdit("tier", { n: index + 1 })}{" "}
                  <span className="font-num tabular-nums text-ink">
                    {cents == null ? "—" : formatEuros(cents, locale)}
                  </span>
                </span>
              );
            })}
          </div>
          <p className="border-t border-[#F4F0EC] px-5 py-3 text-[11px] text-muted">
            {tEdit("pricesHint")}
          </p>
        </section>

        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" className={BTN_PRIMARY}>
            {tEdit("save")}
          </button>
          <Link href={`/${locale}/staff/productos`} className={BTN_QUIET}>
            {tEdit("back")}
          </Link>
        </div>
      </form>
    </StaffShell>
  );
}
