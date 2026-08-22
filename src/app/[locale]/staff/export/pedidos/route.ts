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

  const firstOrderRange = scanRange(0);
  const firstOrders = await admin
    .from("orders")
    .select(
      "id, order_number, company_id, status, delivery_date, customer_note, subtotal_cents, erp_can, erp_eje, numped, numalb, created_at, confirmed_at, injected_at, albaran_at",
      { count: "exact" },
    )
    .order("created_at")
    .order("id")
    .range(firstOrderRange.from, firstOrderRange.to);
  if (firstOrders.error || firstOrders.count === null) {
    console.error("order export:", firstOrders.error ?? "missing exact count");
    return new Response("Export unavailable", { status: 503 });
  }
  if (scanTruncated(firstOrders.count)) {
    console.error(`order export: ${firstOrders.count} rows exceeds scan ceiling`);
    return new Response("Export is too large", { status: 413 });
  }
  const orders = [...(firstOrders.data ?? [])];
  for (let index = 1; index < scanWindowCount(firstOrders.count); index++) {
    const range = scanRange(index);
    const page = await admin
      .from("orders")
      .select(
        "id, order_number, company_id, status, delivery_date, customer_note, subtotal_cents, erp_can, erp_eje, numped, numalb, created_at, confirmed_at, injected_at, albaran_at",
      )
      .order("created_at")
      .order("id")
      .range(range.from, range.to);
    if (page.error) {
      console.error("order export page:", page.error);
      return new Response("Export unavailable", { status: 503 });
    }
    orders.push(...(page.data ?? []));
  }

  const firstItemRange = scanRange(0);
  const firstItems = await admin
    .from("order_items")
    .select(
      "id, order_id, codart, name, qty, unit, units_per_case, unit_price_cents, line_total_cents, is_weighed, is_erp_excluded, sort_order",
      { count: "exact" },
    )
    .order("id")
    .range(firstItemRange.from, firstItemRange.to);
  if (firstItems.error || firstItems.count === null) {
    console.error("order item export:", firstItems.error ?? "missing exact count");
    return new Response("Export unavailable", { status: 503 });
  }
  if (scanTruncated(firstItems.count)) {
    console.error(`order item export: ${firstItems.count} rows exceeds scan ceiling`);
    return new Response("Export is too large", { status: 413 });
  }
  const items = [...(firstItems.data ?? [])];
  for (let index = 1; index < scanWindowCount(firstItems.count); index++) {
    const range = scanRange(index);
    const page = await admin
      .from("order_items")
      .select(
        "id, order_id, codart, name, qty, unit, units_per_case, unit_price_cents, line_total_cents, is_weighed, is_erp_excluded, sort_order",
      )
      .order("id")
      .range(range.from, range.to);
    if (page.error) {
      console.error("order item export page:", page.error);
      return new Response("Export unavailable", { status: 503 });
    }
    items.push(...(page.data ?? []));
  }

  const { data: companyRows, error: companyError } = await admin
    .from("companies")
    .select("id, name, codcli");
  if (companyError) {
    console.error("order export companies:", companyError);
    return new Response("Export unavailable", { status: 503 });
  }
  const companies = new Map((companyRows ?? []).map((row) => [row.id, row]));
  const itemsByOrder = new Map<string, typeof items>();
  for (const item of items) {
    const bucket = itemsByOrder.get(item.order_id);
    if (bucket) bucket.push(item);
    else itemsByOrder.set(item.order_id, [item]);
  }

  const headers =
    locale === "zh"
      ? ["订单号", "创建时间", "状态", "公司", "Wingest客户号", "配送日期", "SKU", "商品名称", "数量", "单位", "单价", "行小计", "订单总额", "ERP系列", "ERP年度", "Wingest订单号", "送货单号", "客户备注"]
      : ["Pedido", "Creado", "Estado", "Empresa", "Cliente Wingest", "Entrega", "SKU", "Producto", "Cantidad", "Unidad", "Precio unitario", "Total línea", "Total pedido", "Serie ERP", "Ejercicio ERP", "Pedido Wingest", "Albarán", "Observaciones"];
  const statusZh: Record<string, string> = {
    submitted: "待确认",
    confirmed: "已确认",
    processing: "导入中",
    bridge_failed: "需人工处理",
    injected: "已导入",
    albaran: "已开送货单",
    cancelled: "已取消",
  };
  const statusEs: Record<string, string> = {
    submitted: "Pendiente",
    confirmed: "Confirmado",
    processing: "En proceso",
    bridge_failed: "Revisión manual",
    injected: "Inyectado",
    albaran: "Con albarán",
    cancelled: "Cancelado",
  };

  const rows: unknown[][] = [headers];
  for (const order of orders) {
    const company = companies.get(order.company_id);
    const lines = itemsByOrder.get(order.id) ?? [null];
    for (const line of lines) {
      rows.push([
        order.order_number,
        order.created_at,
        (locale === "zh" ? statusZh : statusEs)[order.status] ?? order.status,
        company?.name,
        company?.codcli,
        order.delivery_date,
        line?.codart,
        localizedName(line?.name, locale),
        line?.qty,
        line?.unit,
        line ? (line.unit_price_cents / 100).toFixed(2) : "",
        line ? (line.line_total_cents / 100).toFixed(2) : "",
        (order.subtotal_cents / 100).toFixed(2),
        order.erp_can,
        order.erp_eje,
        order.numped,
        order.numalb,
        order.customer_note,
      ]);
    }
  }

  return csvResponse(
    `dada-orders-${new Date().toISOString().slice(0, 10)}.csv`,
    rows,
  );
}
