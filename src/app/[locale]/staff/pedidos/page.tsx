import type { Locale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import Link from "next/link";
import { cancelOrder, confirmOrder } from "@/app/actions/staff-orders";
import { OrderStatusBadge } from "@/components/order-status-badge";
import { StaffShell } from "@/components/staff-shell";
import { FIELD_SM, GLASS_CARD } from "@/components/ui";
import { beginStaff, finishStaff } from "@/lib/auth/guards";
import { localizedName, unitLabel } from "@/lib/catalog/display";
import { formatEuros } from "@/lib/money";
import type { QueueTab } from "@/lib/orders";
import {
  formatOrderDate,
  isLineEditResult,
  QUEUE_TABS,
  safeQueueTab,
} from "@/lib/orders";
import { perfRun } from "@/lib/perf";
import type { Database } from "@/lib/supabase/database.types";
import type { PublicOrder } from "@/lib/supabase/public.types";
import { PUBLIC_ORDER_COLUMNS } from "@/lib/supabase/public.types";
import { LineQtyForm } from "./line-qty-form";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

/**
 * The customer-readable order columns plus the restaurant that placed it.
 *
 * Staff read orders on the SAME authenticated client and the SAME column list:
 * `staff_note` is revoked from authenticated whoever is asking (CLAUDE.md), so
 * a staff page that reached for it would 403 exactly like a customer page.
 * Notes go IN through the RPCs and are read back with service-role tooling.
 */
type QueueOrder = PublicOrder & {
  companies: { name: string; codcli: number | null } | null;
};

/**
 * Exactly the line columns this page renders, off the order's own snapshot —
 * plus the one thing that is deliberately NOT a snapshot.
 *
 * `is_weighed` exists in both places and they mean different things. The line's
 * copy is what the order was placed under and what the bridge sends Wingest; the
 * product's is the rule for what a quantity may look like TODAY, which is what
 * the editor below needs, and what `staff_update_order_line` re-reads for itself.
 * Flagging an article as weighed has to reach the orders already sitting in this
 * queue, so the live flag wins and the snapshot is the fallback for a line whose
 * product row is gone.
 *
 * The two can no longer drift apart on a line anyone has touched: since v2 of
 * the RPC (2026-08-17, after order 1007 stranded the bridge) an accepted edit
 * WRITES the coalesced value back onto the line, so the snapshot always records
 * the terms the quantity beside it was last judged under. Unedited lines keep
 * the value they were placed with, which is why this fallback still has work to
 * do.
 */
type QueueItem = Pick<
  Database["public"]["Tables"]["order_items"]["Row"],
  | "id"
  | "order_id"
  | "codart"
  | "name"
  | "qty"
  | "unit"
  | "units_per_case"
  | "unit_price_cents"
  | "line_total_cents"
  | "is_weighed"
> & { products: { is_weighed: boolean } | null };

export default async function StaffOrdersPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: Locale }>;
  searchParams: Promise<{
    estado?: string;
    rpcResult?: string;
    lineResult?: string;
  }>;
}) {
  const { locale } = await params;
  const {
    estado: rawEstado,
    rpcResult: rawResult,
    lineResult: rawLineResult,
  } = await searchParams;
  setRequestLocale(locale);
  const perf = perfRun(`/${locale}/staff/pedidos`);
  const { supabase, pendingStaff } = await beginStaff(locale);
  const t = await getTranslations("staff");
  // The order vocabulary is the customer's, the money labels are the cart's:
  // reused rather than duplicated into the staff namespace.
  const tOrders = await getTranslations("orders");
  const tCart = await getTranslations("cart");
  // …and the 称重 badge is the catalogue's, for the same reason.
  const tCatalog = await getTranslations("catalog");

  // Both query strings are user-editable. The tab reaches `.eq("status", …)`,
  // so it is validated before it is used, not after.
  const tab = safeQueueTab(rawEstado);
  const rpcResult =
    rawResult === "ok" || rawResult === "wrong-state" || rawResult === "error"
      ? rawResult
      : null;
  // The line editor answers on its own parameter rather than sharing `rpcResult`:
  // its vocabulary is six codes wide (a quantity can be refused four ways), and a
  // redirect only ever sets one of the two.
  const lineResult =
    typeof rawLineResult === "string" && isLineEditResult(rawLineResult)
      ? rawLineResult
      : null;

  let query = supabase
    .from("orders")
    .select(`${PUBLIC_ORDER_COLUMNS}, companies:company_id(name, codcli)`)
    .order("created_at", { ascending: false })
    .limit(PAGE_SIZE);
  // `all` is the absence of a filter, which is why it is not a status.
  if (tab !== "all") query = query.eq("status", tab);

  // The queue is built from `?estado=` alone, so it needs nothing the guard is
  // fetching and goes out beside it. This is the SESSION client: `orders_read`
  // opens the whole table to staff and to nobody else, so a caller who turns out
  // not to be staff reads their own restaurant's orders at worst — and is
  // redirected before a single row is rendered.
  const [staffUser, { data, error }] = await Promise.all([
    finishStaff(pendingStaff, locale),
    perf.step("orders", query),
  ]);
  if (error) console.error("staff orders query:", error);
  const orders: QueueOrder[] = data ?? [];

  // Second query rather than a nested embed: the lines are grouped here, once,
  // and the orders query stays a plain column list. It is the one read on this
  // page that genuinely queues, because the order ids ARE its filter.
  const orderIds = orders.map((order) => order.id);
  let items: QueueItem[] = [];
  if (orderIds.length > 0) {
    const { data: itemData, error: itemError } = await perf.step(
      "orderItems",
      supabase
        .from("order_items")
        // One string literal, never a concatenation: supabase-js types the row
        // from the literal, and `"a, " + "b"` widens to `string` and loses it.
        // The embed is the product's live `is_weighed`, joined through the line's
        // own FK column exactly as the orders query joins `companies` — one more
        // join on the same round trip, rather than a second query per card.
        .select(
          "id, order_id, codart, name, qty, unit, units_per_case, unit_price_cents, line_total_cents, is_weighed, products:product_id(is_weighed)",
        )
        .in("order_id", orderIds)
        .order("sort_order", { ascending: true }),
    );
    if (itemError) console.error("staff order items query:", itemError);
    items = itemData ?? [];
  }
  perf.end();

  const linesByOrder = new Map<string, QueueItem[]>();
  for (const item of items) {
    const lines = linesByOrder.get(item.order_id);
    if (lines) lines.push(item);
    else linesByOrder.set(item.order_id, [item]);
  }

  // A tab switch drops `?rpcResult`: the banner belongs to the click that
  // produced it, not to the next view the staff member opens.
  const tabHref = (target: QueueTab) =>
    `/${locale}/staff/pedidos${target === "submitted" ? "" : `?estado=${target}`}`;

  const tabLabel: Record<QueueTab, string> = {
    submitted: t("tabSubmitted"),
    confirmed: t("tabConfirmed"),
    all: t("tabAll"),
  };

  return (
    <StaffShell
      locale={locale}
      title={t("ordersQueue")}
      breadcrumb={t("nav.orders")}
      user={{
        name: staffUser.display_name ?? staffUser.id,
        role: staffUser.role,
      }}
    >
      {rpcResult && (
        <p
          role={rpcResult === "ok" ? "status" : "alert"}
          className={`mt-4 rounded-lg px-3 py-2 text-sm ${
            rpcResult === "ok"
              ? "bg-green-50 text-green-800"
              : rpcResult === "wrong-state"
                ? "bg-amber-50 text-amber-800"
                : "bg-red-50 text-red-700"
          }`}
        >
          {/* `false` from either RPC means the order had already moved on —
              someone else got there first. It is reported, never assumed away. */}
          {rpcResult === "ok"
            ? t("rpcOk")
            : rpcResult === "wrong-state"
              ? t("rpcWrongState")
              : t("rpcFailed")}
        </p>
      )}

      {lineResult && (
        <p
          role={lineResult === "ok" ? "status" : "alert"}
          className={`mt-4 rounded-lg px-3 py-2 text-sm ${
            lineResult === "ok"
              ? "bg-green-50 text-green-800"
              : // The order moved on under the staff member's feet. Amber, like
                // the transitions' own version of the same news: nothing broke,
                // and nothing was written either.
                lineResult === "WRONG_STATE"
                ? "bg-amber-50 text-amber-800"
                : "bg-red-50 text-red-700"
          }`}
        >
          {t(`lineResults.${lineResult}`)}
        </p>
      )}

      <nav className="mt-6 flex gap-5 border-b border-border text-sm">
        {QUEUE_TABS.map((target) => (
          <Link
            key={target}
            href={tabHref(target)}
            className={
              tab === target
                ? "-mb-px border-b-2 border-brand pb-2 font-semibold"
                : "-mb-px border-b-2 border-transparent pb-2 text-muted transition-colors hover:text-ink"
            }
          >
            {tabLabel[target]}
          </Link>
        ))}
      </nav>

      {orders.length === 0 ? (
        <p className={`${GLASS_CARD} mt-4 p-10 text-center text-muted`}>
          {t("noOrders")}
        </p>
      ) : (
        <ul className={`${GLASS_CARD} mt-4 divide-y divide-border px-4 sm:px-5`}>
          {orders.map((order) => {
            const lines = linesByOrder.get(order.id) ?? [];
            // Both RPCs update `where status = 'submitted'`, so on any other
            // state these buttons could only ever come back false. The queue
            // shows the order and leaves out the controls that cannot work.
            const actionable = order.status === "submitted";
            // The quantity boxes belong to the 待确认 view and nowhere else. A
            // submitted order is reachable from 全部 too, and an editable field
            // there would be an invitation to change a pedido somebody opened
            // the tab to READ. `staff_update_order_line` would accept it; this
            // page does not offer it.
            const editable = actionable && tab === "submitted";
            return (
              // The queue is read by scanning down it, so the row answers the
              // pointer the way an admin table does. `-mx-2 px-2` is what lets
              // the tint reach past the text column instead of stopping at it.
              <li
                key={order.id}
                className="-mx-2 rounded-lg px-2 py-3 transition-colors hover:bg-white/50"
              >
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <p className="font-medium">
                    {tOrders("orderNumber", { n: order.order_number })}
                  </p>
                  <OrderStatusBadge status={order.status} />
                  {/* The restaurant, then its ERP customer number — the two
                      things a staff member matches against Wingest. */}
                  <span className="min-w-0 truncate text-sm text-muted">
                    {order.companies?.name ?? "—"}
                    {order.companies?.codcli != null &&
                      ` · ${order.companies.codcli}`}
                  </span>
                  {/* Money is right-aligned and `tabular-nums` down the whole
                      queue, so the euro columns line up digit under digit the
                      way they do on the albarán being checked against it. */}
                  <p className="ml-auto text-right font-semibold tabular-nums">
                    <span className="sr-only">{tCart("subtotal")}: </span>
                    {formatEuros(order.subtotal_cents, locale)}
                  </p>
                </div>

                <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
                  <span>
                    {tOrders("placedAt")}:{" "}
                    {formatOrderDate(order.created_at, locale)}
                  </span>
                  {order.delivery_date && (
                    <span>
                      {tCart("deliveryDate")}:{" "}
                      {formatOrderDate(order.delivery_date, locale)}
                    </span>
                  )}
                  {order.numped != null && (
                    <span>{tOrders("erpOrder", { n: order.numped })}</span>
                  )}
                  {order.numalb != null && (
                    <span>{tOrders("erpAlbaran", { n: order.numalb })}</span>
                  )}
                </div>

                {order.customer_note && (
                  <p className="mt-1 text-sm">
                    {t("customerNote")}: {order.customer_note}
                  </p>
                )}

                {/* Lines fold away so a screen of orders stays a screen; no
                    client component is needed for a <details>. */}
                <details className="mt-2">
                  <summary className="cursor-pointer text-sm text-muted transition-colors hover:text-ink">
                    {t("orderLines", { n: lines.length })}
                  </summary>
                  <ul className="mt-1 space-y-1 text-sm">
                    {lines.map((line) => {
                      // The live flag, with the line's own snapshot as the
                      // fallback — the same coalesce the RPC makes, so the box
                      // this row draws and the rule that judges it agree. Saving
                      // the row also writes that value onto the line, so the
                      // snapshot the bridge later reads agrees with it too.
                      const weighed =
                        line.products?.is_weighed ?? line.is_weighed;
                      // The per-caja price. `qty` is CAJAS and
                      // `unit_price_cents` is the ERP's per-base-unit price, so
                      // those two do not multiply out to the total beside them —
                      // `units_per_case x unit_price_cents` does, both
                      // snapshotted on the line, so `qty x this =
                      // line_total_cents` exactly and the row reads the way a
                      // staff member checking an albarán needs it to.
                      const perCase = formatEuros(
                        line.units_per_case * line.unit_price_cents,
                        locale,
                      );
                      const name = localizedName(line.name, locale);
                      return (
                        <li
                          key={line.id}
                          className="flex flex-wrap items-center gap-x-2 gap-y-0.5"
                        >
                          <span className="font-mono text-xs text-muted">
                            {line.codart}
                          </span>
                          {/* The name is the order's own snapshot, not the
                              product's — a renamed article still reads the way
                              the customer ordered it. */}
                          <span className="min-w-0 flex-1 truncate">{name}</span>
                          {/* Why this line's box takes decimals, said once, in
                              the vocabulary the catalogue already uses. */}
                          {weighed && (
                            <span className="rounded-md bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800">
                              {tCatalog("weighed")}
                            </span>
                          )}
                          {editable ? (
                            <>
                              <LineQtyForm
                                orderId={order.id}
                                itemId={line.id}
                                qty={line.qty}
                                isWeighed={weighed}
                                locale={locale}
                                tab={tab}
                                labels={{
                                  save: t("saveQty"),
                                  saveFor: t("saveQtyFor", { name }),
                                  qtyFor: t("lineQtyFor", { name }),
                                  kg: t("kg"),
                                }}
                              />
                              {/* The packaging fact the read-only row states,
                                  kept on the editable one: `CAJA×24` is what
                                  makes the price beside it legible, and 待确认
                                  is the tab where somebody is deciding a
                                  quantity against it. */}
                              <span className="text-xs text-muted tabular-nums">
                                {unitLabel(line.unit, line.units_per_case)} ×{" "}
                                {perCase}
                              </span>
                            </>
                          ) : (
                            <span className="text-xs text-muted tabular-nums">
                              {line.qty}{" "}
                              {unitLabel(line.unit, line.units_per_case)} ×{" "}
                              {perCase}
                            </span>
                          )}
                          <span className="w-20 text-right tabular-nums">
                            {formatEuros(line.line_total_cents, locale)}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </details>

                {actionable && (
                  <div className="mt-3 flex flex-wrap items-start gap-x-4 gap-y-2">
                    <form
                      action={confirmOrder}
                      className="flex flex-wrap items-center gap-1"
                    >
                      <input type="hidden" name="order_id" value={order.id} />
                      <input type="hidden" name="locale" value={locale} />
                      {/* So the redirect comes back to the tab in front of the
                          staff member, not to the default one. */}
                      <input type="hidden" name="estado" value={tab} />
                      <input
                        name="note"
                        // staff_confirm_order rejects anything longer.
                        maxLength={2000}
                        placeholder={t("staffNote")}
                        // One "Nota interna" per row would tell a screen reader
                        // nothing about which order it belongs to.
                        aria-label={t("staffNoteFor", {
                          n: order.order_number,
                        })}
                        className={`w-48 ${FIELD_SM}`}
                      />
                      <button
                        type="submit"
                        aria-label={t("confirmFor", { n: order.order_number })}
                        className="rounded-lg bg-brand px-3 py-1 text-sm text-white transition-colors hover:bg-brand/90"
                      >
                        {t("confirm")}
                      </button>
                    </form>

                    <form
                      action={cancelOrder}
                      className="flex flex-wrap items-center gap-1"
                    >
                      <input type="hidden" name="order_id" value={order.id} />
                      <input type="hidden" name="locale" value={locale} />
                      <input type="hidden" name="estado" value={tab} />
                      <input
                        name="note"
                        maxLength={2000}
                        placeholder={t("cancelReason")}
                        aria-label={t("cancelReasonFor", {
                          n: order.order_number,
                        })}
                        className={`w-48 ${FIELD_SM}`}
                      />
                      {/* Cancelling is destructive, not the accent: it keeps the
                          semantic red it has always had. */}
                      <button
                        type="submit"
                        aria-label={t("cancelFor", { n: order.order_number })}
                        className="rounded-lg border border-red-300 px-3 py-1 text-sm text-red-700 transition-colors hover:bg-red-50"
                      >
                        {t("cancel")}
                      </button>
                    </form>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </StaffShell>
  );
}
