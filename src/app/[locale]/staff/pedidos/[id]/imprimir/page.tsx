import type { Locale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { ProductThumb, THUMB_LG_PX } from "@/components/product-thumb";
import { beginStaff, finishStaff } from "@/lib/auth/guards";
import { localizedName, unitLabel } from "@/lib/catalog/display";
import { formatEuros } from "@/lib/money";
import { formatOrderDate, isUuid, orderUnits } from "@/lib/orders";
import type { Database } from "@/lib/supabase/database.types";
import type { PublicOrder } from "@/lib/supabase/public.types";
import { PUBLIC_ORDER_COLUMNS } from "@/lib/supabase/public.types";
import { PrintButton } from "./print-button";

export const dynamic = "force-dynamic";

/**
 * The A4 print sheet for ONE order — the successor of the freepos 销售单 the
 * shop printed for a decade, drawn to the owner's spec (2026-08-20): the order
 * number on top; a boxed header of 单号 / 日期 / 客户 / 地址 / 数量 / 备注; then
 * the lines as 图片 · SKU · 数量 · 价格 · 产品名称 · Total, with the QUANTITY
 * set in the sheet's largest type — this paper is picked against in a warehouse,
 * and the number of cases is what the picker reads at arm's length.
 *
 * **Deliberately OUTSIDE `StaffShell`.** A print route's whole DOM goes to the
 * printer; a sidebar would have to be display:none'd back out of every page of
 * output. The screen shows the same sheet centred on the admin ground with a
 * small toolbar above it, and that toolbar is the only thing `print:hidden`
 * has to swallow.
 *
 * **`?precios=0` hides money.** The owner asked for the price and total columns
 * to be REMOVABLE, not restyled: a copy that rides with the driver or hangs in
 * the warehouse shouldn't show the tarifa. Server-rendered from the query
 * parameter — the toggle is two links, no client state, and the printed DOM
 * simply never contains the columns. Prices default ON: the office copy is the
 * common case, and staff pages always see money.
 *
 * Everything on the sheet is the order's own SNAPSHOT (name, unit, factor,
 * cents as placed) — the one live read is the photos, exactly as the customer's
 * order card does it, because the snapshot has never carried one.
 */

/** The line columns this sheet prints, plus the live photo join. */
type PrintLine = Pick<
  Database["public"]["Tables"]["order_items"]["Row"],
  | "id"
  | "codart"
  | "name"
  | "qty"
  | "unit"
  | "units_per_case"
  | "unit_price_cents"
  | "line_total_cents"
  | "is_weighed"
> & { products: { image_url: string | null } | null };

/** `orders` row plus the company block the header prints. */
type PrintOrder = PublicOrder & {
  companies: {
    name: string;
    codcli: number | null;
    address: string | null;
    address_city: string | null;
    address_postal: string | null;
  } | null;
};

export default async function PrintOrderPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: Locale; id: string }>;
  searchParams: Promise<{ precios?: string }>;
}) {
  const { locale, id } = await params;
  const { precios } = await searchParams;
  setRequestLocale(locale);

  // `?id` is path input: anything that is not a uuid can only be a typed URL,
  // and answering it with a Postgres cast error would 500 where a 404 is meant.
  if (!isUuid(id)) notFound();

  const { supabase, pendingStaff } = await beginStaff(locale);
  const t = await getTranslations("staff");
  const tOrders = await getTranslations("orders");
  const tCart = await getTranslations("cart");

  // The order needs nothing from the guard, so the two go out side by side —
  // the queue's own idiom. SESSION client: `orders_read` opens the table to
  // staff; a caller who turns out not to be staff is redirected by
  // `finishStaff` before a byte of this sheet is rendered.
  const [, orderResult] = await Promise.all([
    finishStaff(pendingStaff, locale),
    supabase
      .from("orders")
      .select(
        `${PUBLIC_ORDER_COLUMNS}, companies:company_id(name, codcli, address, address_city, address_postal)`,
      )
      .eq("id", id)
      .maybeSingle(),
  ]);

  if (orderResult.error) console.error("print order query:", orderResult.error);
  const order = orderResult.data as PrintOrder | null;
  if (!order) notFound();

  // One string literal, never a concatenation — the queue's note about typed
  // selects applies here verbatim. The photo joins through the line's FK as the
  // queue joins `is_weighed`; a vanished product leaves `products` null and the
  // thumb draws its placeholder box.
  const { data: lineRows, error: linesError } = await supabase
    .from("order_items")
    .select(
      "id, codart, name, qty, unit, units_per_case, unit_price_cents, line_total_cents, is_weighed, products:product_id(image_url)",
    )
    .eq("order_id", id)
    .order("sort_order", { ascending: true });
  if (linesError) console.error("print order lines query:", linesError);
  const lines: PrintLine[] = lineRows ?? [];

  // An order always HAS lines, so an empty read here is a failed read — the
  // customer card's rule. The sheet still prints its header (the paper may be
  // wanted for the note alone), but it says the lines are missing rather than
  // laying out an empty table under a true header.
  const hasLines = lines.length > 0;

  const showPrices = precios !== "0";

  // The header's 数量 — total UNITS across the order (cases + kilos summed the
  // portal's own way), the figure the freepos header printed in its last cell.
  const totalUnits = orderUnits(lines.map((line) => line.qty));

  // One formatter per sheet, as the customer card builds one per card: the
  // quantity column and the money must agree on whether half a kilo is 0.5 or
  // 0,5 down the whole page.
  const qtyFormat = new Intl.NumberFormat(locale === "zh" ? "zh-CN" : "es-ES");

  const address = [
    order.companies?.address,
    order.companies?.address_city,
    order.companies?.address_postal,
  ]
    .filter(Boolean)
    .join(", ");

  // The toggle's other half: same sheet, opposite `?precios=`. Built by hand —
  // one parameter, two states — rather than importing a URL helper for it.
  const toggleHref = `/${locale}/staff/pedidos/${id}/imprimir${
    showPrices ? "?precios=0" : ""
  }`;

  /** One boxed header cell: the tiny label row over the value. */
  const headCell = (label: string, value: ReactNode) => (
    <td className="border border-neutral-500 px-2 py-1 align-top">
      <span className="block text-[10px] text-neutral-600">{label}</span>
      <span className="block text-[13px] leading-snug">{value}</span>
    </td>
  );

  return (
    <>
      {/* The page setup the CSS files cannot carry: `@page` is per-route here
          (A4, tight margins), and the print pass strips the screen chrome —
          the beige ground and the sheet's shadow — so the printer gets black
          on white and nothing else. `-webkit-print-color-adjust` keeps the
          thead's grey fill on paper; without it Chrome prints the header row
          as white and the table loses its anchor line. */}
      <style>{`
        @page { size: A4; margin: 10mm 9mm; }
        @media print {
          body { background: #fff !important; }
          .print-sheet { box-shadow: none !important; margin: 0 !important; padding: 0 !important; max-width: none !important; border-radius: 0 !important; }
          thead { display: table-header-group; }
          tr { break-inside: avoid; }
          * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        }
      `}</style>

      <div className="mx-auto max-w-[210mm] px-4 py-4 print:p-0">
        {/* The toolbar — everything on this screen that must NOT reach paper. */}
        <div className="mb-4 flex flex-wrap items-center gap-3 print:hidden">
          <Link
            href={`/${locale}/staff/pedidos`}
            className="text-sm text-muted transition-colors hover:text-brand-ink"
          >
            ‹ {t("print.back")}
          </Link>
          <div className="ml-auto flex items-center gap-3">
            {/* A LINK, not a checkbox: the state lives in the URL, so the
                printed copy and the address bar can never disagree about
                whether money was on the paper. */}
            <Link
              href={toggleHref}
              className="text-sm text-brand-ink underline underline-offset-4"
            >
              {showPrices ? t("print.hidePrices") : t("print.showPrices")}
            </Link>
            <PrintButton />
          </div>
        </div>

        <div className="print-sheet rounded-card bg-white p-[9mm] shadow-[0_2px_16px_rgba(28,25,23,.12)]">
          {/* The order number, top and biggest — the one thing the owner asked
              to see first on the paper. */}
          <h1 className="font-num text-2xl font-bold tracking-tight">
            {tOrders("orderNumber", { n: order.order_number })}
          </h1>

          {/* The boxed header, the freepos shape: one row of labelled cells,
              then the note across the full width. `table-fixed` so a long
              address widens nothing — it wraps inside its own cell. */}
          <table className="mt-3 w-full table-fixed border-collapse">
            <tbody>
              <tr>
                <td className="w-[16%] border border-neutral-500 px-2 py-1 align-top">
                  <span className="block text-[10px] text-neutral-600">
                    {t("print.number")}
                  </span>
                  <span className="block font-num text-[13px] font-semibold">
                    {order.order_number}
                  </span>
                </td>
                {headCell(
                  t("print.date"),
                  formatOrderDate(order.created_at, locale),
                )}
                {headCell(
                  t("print.client"),
                  <>
                    {order.companies?.name ?? "—"}
                    {order.companies?.codcli != null && (
                      <span className="text-neutral-600">
                        {" "}
                        · {order.companies.codcli}
                      </span>
                    )}
                  </>,
                )}
                {headCell(t("print.address"), address || "—")}
                <td className="w-[12%] border border-neutral-500 px-2 py-1 align-top">
                  <span className="block text-[10px] text-neutral-600">
                    {t("print.units")}
                  </span>
                  <span className="block font-num text-[15px] font-bold tabular-nums">
                    {hasLines ? qtyFormat.format(totalUnits) : "—"}
                  </span>
                </td>
              </tr>
              <tr>
                <td colSpan={5} className="border border-neutral-500 px-2 py-1">
                  <span className="block text-[10px] text-neutral-600">
                    {t("print.note")}
                  </span>
                  <span className="block min-h-[1.25rem] text-[13px] leading-snug">
                    {order.customer_note || "—"}
                  </span>
                </td>
              </tr>
            </tbody>
          </table>

          {/* The lines. A real <table> with a real <thead>, because that is
              what makes the column heads repeat at the top of every printed
              page — the freepos sheet ran to four pages and so will an August
              order here. */}
          {hasLines ? (
            <table className="mt-4 w-full border-collapse text-[13px]">
              <thead>
                <tr className="bg-neutral-100 text-left text-[11px] text-neutral-700">
                  {/* 50px thumb + the cell's 4px padding each side. */}
                  <th className="w-[58px] border border-neutral-500 px-1.5 py-1 font-medium">
                    {t("print.colPhoto")}
                  </th>
                  <th className="w-[72px] border border-neutral-500 px-1.5 py-1 font-medium">
                    {t("print.colSku")}
                  </th>
                  <th className="w-[64px] border border-neutral-500 px-1.5 py-1 font-medium">
                    {t("print.colQty")}
                  </th>
                  {showPrices && (
                    <th className="w-[72px] border border-neutral-500 px-1.5 py-1 text-right font-medium">
                      {t("print.colPrice")}
                    </th>
                  )}
                  <th className="border border-neutral-500 px-1.5 py-1 font-medium">
                    {t("print.colProduct")}
                  </th>
                  {showPrices && (
                    <th className="w-[80px] border border-neutral-500 px-1.5 py-1 text-right font-medium">
                      {t("print.colTotal")}
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {lines.map((line) => {
                  // The per-CASE price — `unit_price_cents` is the snapshot's
                  // per-BOTTLE figure, and a price printed beside a quantity
                  // in cases must be the price of a case (weighed lines have
                  // factor 1, so theirs is per kilo). Exact integer
                  // multiplication, the view's own arithmetic.
                  const caseCents =
                    line.unit_price_cents * line.units_per_case;
                  return (
                    <tr key={line.id}>
                      <td className="border border-neutral-500 p-1">
                        <ProductThumb
                          src={line.products?.image_url ?? null}
                          size={THUMB_LG_PX}
                        />
                      </td>
                      <td className="border border-neutral-500 px-1.5 py-1 align-middle font-num text-[12px]">
                        {line.codart}
                      </td>
                      {/* The sheet's largest type, by the owner's ask: the
                          picker reads THIS number at arm's length. The unit
                          under it says what one of them is — KG on a weighed
                          line, the sale unit otherwise. */}
                      <td className="border border-neutral-500 px-1.5 py-1 text-center align-middle">
                        <span className="block font-num text-[22px] leading-tight font-bold tabular-nums">
                          {qtyFormat.format(line.qty)}
                        </span>
                        <span className="block text-[10px] text-neutral-600">
                          {line.is_weighed ? "KG" : (line.unit ?? "")}
                        </span>
                      </td>
                      {showPrices && (
                        <td className="border border-neutral-500 px-1.5 py-1 text-right align-middle font-num tabular-nums">
                          {formatEuros(caseCents, locale)}
                        </td>
                      )}
                      <td className="border border-neutral-500 px-1.5 py-1 align-middle">
                        <span className="block leading-snug font-medium">
                          {localizedName(line.name, locale) || line.codart}
                        </span>
                        {unitLabel(line.unit, line.units_per_case) && (
                          <span className="block text-[10.5px] text-neutral-600">
                            {unitLabel(line.unit, line.units_per_case)}
                          </span>
                        )}
                      </td>
                      {showPrices && (
                        <td className="border border-neutral-500 px-1.5 py-1 text-right align-middle font-num font-semibold tabular-nums">
                          {formatEuros(line.line_total_cents, locale)}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
              {showPrices && (
                <tfoot>
                  <tr>
                    <td
                      colSpan={4}
                      className="border border-neutral-500 px-1.5 py-1.5 text-right text-[12px] text-neutral-700"
                    >
                      {tCart("subtotal")}
                    </td>
                    <td
                      colSpan={2}
                      className="border border-neutral-500 px-1.5 py-1.5 text-right align-middle font-num text-[15px] font-bold tabular-nums"
                    >
                      {formatEuros(order.subtotal_cents, locale)}
                    </td>
                  </tr>
                </tfoot>
              )}
            </table>
          ) : (
            // The failed-read shape: a sheet that says so beats an empty table
            // pretending the order has nothing in it.
            <p className="mt-4 text-sm text-red-700">{t("print.noLines")}</p>
          )}
        </div>
      </div>
    </>
  );
}
