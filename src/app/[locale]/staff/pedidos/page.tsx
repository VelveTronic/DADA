import type { Locale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import Link from "next/link";
import { cancelOrder, confirmOrder } from "@/app/actions/staff-orders";
import { AppShell } from "@/components/app-shell";
import { OrderStatusBadge } from "@/components/order-status-badge";
import { FIELD_SM, GLASS_CARD } from "@/components/ui";
import { requireStaff } from "@/lib/auth/guards";
import { localizedName, unitLabel } from "@/lib/catalog/display";
import { formatEuros } from "@/lib/money";
import type { QueueTab } from "@/lib/orders";
import { formatOrderDate, QUEUE_TABS, safeQueueTab } from "@/lib/orders";
import type { Database } from "@/lib/supabase/database.types";
import type { PublicOrder } from "@/lib/supabase/public.types";
import { PUBLIC_ORDER_COLUMNS } from "@/lib/supabase/public.types";
import { createServerSupabase } from "@/lib/supabase/server";

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

/** Exactly the line columns this page renders, off the order's own snapshot. */
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
>;

export default async function StaffOrdersPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: Locale }>;
  searchParams: Promise<{ estado?: string; rpcResult?: string }>;
}) {
  const { locale } = await params;
  const { estado: rawEstado, rpcResult: rawResult } = await searchParams;
  setRequestLocale(locale);
  const { staffUser } = await requireStaff(locale);
  const t = await getTranslations("staff");
  // The order vocabulary is the customer's, the money labels are the cart's:
  // reused rather than duplicated into the staff namespace.
  const tOrders = await getTranslations("orders");
  const tCart = await getTranslations("cart");

  // Both query strings are user-editable. The tab reaches `.eq("status", …)`,
  // so it is validated before it is used, not after.
  const tab = safeQueueTab(rawEstado);
  const rpcResult =
    rawResult === "ok" || rawResult === "wrong-state" || rawResult === "error"
      ? rawResult
      : null;

  const supabase = await createServerSupabase();
  let query = supabase
    .from("orders")
    .select(`${PUBLIC_ORDER_COLUMNS}, companies:company_id(name, codcli)`)
    .order("created_at", { ascending: false })
    .limit(PAGE_SIZE);
  // `all` is the absence of a filter, which is why it is not a status.
  if (tab !== "all") query = query.eq("status", tab);
  const { data, error } = await query;
  if (error) console.error("staff orders query:", error);
  const orders: QueueOrder[] = data ?? [];

  // Second query rather than a nested embed: the lines are grouped here, once,
  // and the orders query stays a plain column list.
  const orderIds = orders.map((order) => order.id);
  let items: QueueItem[] = [];
  if (orderIds.length > 0) {
    const { data: itemData, error: itemError } = await supabase
      .from("order_items")
      // One string literal, never a concatenation: supabase-js types the row from
      // the literal, and `"a, " + "b"` widens to `string` and loses it.
      .select(
        "id, order_id, codart, name, qty, unit, units_per_case, unit_price_cents, line_total_cents",
      )
      .in("order_id", orderIds)
      .order("sort_order", { ascending: true });
    if (itemError) console.error("staff order items query:", itemError);
    items = itemData ?? [];
  }

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
    <AppShell
      locale={locale}
      nav="staff"
      user={{
        name: staffUser.display_name ?? staffUser.id,
        role: staffUser.role,
      }}
    >
      <h1 className="mt-8 text-2xl font-bold tracking-tight">
        {t("ordersQueue")}
      </h1>

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
            return (
              <li key={order.id} className="py-3">
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
                  <p className="ml-auto text-right font-semibold">
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
                    {lines.map((line) => (
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
                        <span className="min-w-0 flex-1 truncate">
                          {localizedName(line.name, locale)}
                        </span>
                        {/* `qty` is CAJAS and `unit_price_cents` is the ERP's
                            per-base-unit price, so the two do not multiply out
                            to the total beside them. The per-caja price does —
                            `units_per_case x unit_price_cents`, both snapshotted
                            on the line — so `qty x this = line_total_cents`
                            exactly, and the row reads the way a staff member
                            checking an albarán needs it to. */}
                        <span className="text-xs text-muted">
                          {line.qty} {unitLabel(line.unit, line.units_per_case)} ×{" "}
                          {formatEuros(
                            line.units_per_case * line.unit_price_cents,
                            locale,
                          )}
                        </span>
                        <span className="w-20 text-right">
                          {formatEuros(line.line_total_cents, locale)}
                        </span>
                      </li>
                    ))}
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
    </AppShell>
  );
}
