import type { Locale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { AppShell } from "@/components/app-shell";
import { OrderStatusBadge } from "@/components/order-status-badge";
import { GLASS_CARD } from "@/components/ui";
import { requireCompanyUser } from "@/lib/auth/guards";
import { formatEuros } from "@/lib/money";
import { formatOrderDate, parseOrderNumber } from "@/lib/orders";
import { getSetting } from "@/lib/settings";
import type { PublicOrder } from "@/lib/supabase/public.types";
import { PUBLIC_ORDER_COLUMNS } from "@/lib/supabase/public.types";
import { createServerSupabase } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/** A restaurant's own history, newest first; older orders live in the ERP. */
const PAGE_SIZE = 50;

export default async function OrdersPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: Locale }>;
  searchParams: Promise<{ created?: string }>;
}) {
  const { locale } = await params;
  const { created: rawCreated } = await searchParams;
  setRequestLocale(locale);
  const { portalUser } = await requireCompanyUser(locale);
  const t = await getTranslations("orders");
  // The money and date vocabulary is the cart's, reused rather than duplicated
  // into a second namespace.
  const tCart = await getTranslations("cart");

  // `?created=` is user-editable and goes straight into the banner, so it is a
  // plain order number or no banner at all.
  const created = parseOrderNumber(rawCreated);

  const supabase = await createServerSupabase();
  // The history and the owner's price switch race; neither waits on the other.
  const [{ data, error }, showPrices] = await Promise.all([
    supabase
      .from("orders")
      // The enumerated customer-readable list (CLAUDE.md: never `select('*')`
      // from orders — `staff_note` is column-revoked and a star select 403s).
      .select(PUBLIC_ORDER_COLUMNS)
      // Belt: `orders_read` already narrows this to the caller's company.
      // Suspenders: the filter says out loud whose orders this page is for.
      .eq("company_id", portalUser.company_id)
      .order("created_at", { ascending: false })
      .limit(PAGE_SIZE),
    getSetting(supabase, "show_prices"),
  ]);
  if (error) console.error("orders query:", error);
  const orders: PublicOrder[] = data ?? [];

  return (
    <AppShell
      locale={locale}
      user={{ name: portalUser.display_name ?? portalUser.companies.name }}
      showPrices={showPrices}
    >
      <h1 className="mt-8 text-2xl font-bold tracking-tight">{t("title")}</h1>

      {created != null && (
        <p
          role="status"
          className="mt-4 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-800"
        >
          {tCart("success", { n: created })}
        </p>
      )}

      {orders.length === 0 ? (
        <p className={`${GLASS_CARD} mt-4 p-10 text-center text-muted`}>
          {t("empty")}
        </p>
      ) : (
        <ul className={`${GLASS_CARD} mt-4 divide-y divide-border px-4 sm:px-5`}>
          {orders.map((order) => (
            <li key={order.id} className="py-3">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <p className="font-medium">
                  {t("orderNumber", { n: order.order_number })}
                </p>
                <OrderStatusBadge status={order.status} />
                {/* The order's own total, and the sr-only 小计 that names it,
                    stand or fall together. The order still HAS a total — it is
                    stored in cents and the ERP prints it — the customer's screen
                    just does not show it while the switch is off. */}
                {showPrices && (
                  <p className="ml-auto text-right font-semibold">
                    {/* Named for screen readers, silent on screen: a bare amount
                        in a row does not say what it totals. */}
                    <span className="sr-only">{tCart("subtotal")}: </span>
                    {formatEuros(order.subtotal_cents, locale)}
                  </p>
                )}
              </div>

              <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
                <span>
                  {t("placedAt")}: {formatOrderDate(order.created_at, locale)}
                </span>
                {order.delivery_date && (
                  <span>
                    {tCart("deliveryDate")}:{" "}
                    {formatOrderDate(order.delivery_date, locale)}
                  </span>
                )}
                {/* The ERP document numbers appear only once the bridge has
                    written them back, which is exactly when they start being
                    the number a restaurant quotes on the phone. */}
                {order.numped != null && (
                  <span>{t("erpOrder", { n: order.numped })}</span>
                )}
                {order.numalb != null && (
                  <span>{t("erpAlbaran", { n: order.numalb })}</span>
                )}
              </div>

              {order.customer_note && (
                <p className="mt-1 text-sm text-muted">
                  {tCart("note")}: {order.customer_note}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </AppShell>
  );
}
