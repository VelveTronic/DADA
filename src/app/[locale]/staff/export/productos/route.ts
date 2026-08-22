import { hasLocale } from "next-intl";
import { routing } from "@/i18n/routing";
import { beginStaff, finishStaff } from "@/lib/auth/guards";
import { localizedName } from "@/lib/catalog/display";
import { csvResponse } from "@/lib/csv";
import { scanRange, scanTruncated, scanWindowCount } from "@/lib/scan-windows";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ locale: string }> },
) {
  const { locale: candidate } = await context.params;
  if (!hasLocale(routing.locales, candidate)) {
    return new Response("Bad locale", { status: 400 });
  }
  const locale = candidate;
  const { pendingStaff } = await beginStaff(locale);
  await finishStaff(pendingStaff, locale);
  const admin = createAdminClient();

  const firstRange = scanRange(0);
  const first = await admin
    .from("products")
    .select(
      "id, codart, name, category_id, unit, units_per_case, is_available, is_weighed, image_url",
      { count: "exact" },
    )
    .order("id")
    .range(firstRange.from, firstRange.to);
  if (first.error || first.count === null) {
    console.error("product export:", first.error ?? "missing exact count");
    return new Response("Export unavailable", { status: 503 });
  }
  if (scanTruncated(first.count)) {
    console.error(`product export: ${first.count} rows exceeds scan ceiling`);
    return new Response("Export is too large", { status: 413 });
  }

  const products = [...(first.data ?? [])];
  const windows = scanWindowCount(first.count);
  for (let index = 1; index < windows; index++) {
    const range = scanRange(index);
    const page = await admin
      .from("products")
      .select(
        "id, codart, name, category_id, unit, units_per_case, is_available, is_weighed, image_url",
      )
      .order("id")
      .range(range.from, range.to);
    if (page.error) {
      console.error("product export page:", page.error);
      return new Response("Export unavailable", { status: 503 });
    }
    products.push(...(page.data ?? []));
  }

  const { data: categoryRows, error: categoryError } = await admin
    .from("categories")
    .select("id, name, parent_label");
  if (categoryError) {
    console.error("product export categories:", categoryError);
    return new Response("Export unavailable", { status: 503 });
  }
  const categories = new Map(
    (categoryRows ?? []).map((category) => [category.id, category]),
  );

  const headers =
    locale === "zh"
      ? ["SKU", "商品名称", "一级分类", "分类", "单位", "每箱数量", "状态", "称重", "图片"]
      : ["SKU", "Producto", "Categoría principal", "Categoría", "Unidad", "Uds. por caja", "Estado", "Por peso", "Imagen"];
  const yes = locale === "zh" ? "是" : "Sí";
  const no = locale === "zh" ? "否" : "No";
  const active = locale === "zh" ? "已启用" : "Activo";
  const inactive = locale === "zh" ? "已停用" : "Desactivado";

  const rows: unknown[][] = [headers];
  for (const product of products) {
    const category =
      product.category_id == null ? undefined : categories.get(product.category_id);
    rows.push([
      product.codart,
      localizedName(product.name, locale),
      localizedName(category?.parent_label, locale),
      localizedName(category?.name, locale),
      product.unit,
      product.units_per_case,
      product.is_available ? active : inactive,
      product.is_weighed ? yes : no,
      product.image_url,
    ]);
  }

  return csvResponse(
    `dada-products-${new Date().toISOString().slice(0, 10)}.csv`,
    rows,
  );
}
