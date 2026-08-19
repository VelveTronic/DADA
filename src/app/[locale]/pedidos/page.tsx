import type { Locale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import Link from "next/link";
import { reorderIntoCart } from "@/app/actions/cart";
import { AppShell } from "@/components/app-shell";
import { CARD } from "@/components/ui";
import { beginCompanyUser, finishCompanyUser } from "@/lib/auth/guards";
import type { CustomerOrderTab } from "@/lib/orders";
import {
  isCustomerOrderTab,
  parseOrderNumber,
  statusesForTab,
} from "@/lib/orders";
import { perfRun } from "@/lib/perf";
import { getSetting } from "@/lib/settings";
import type { PublicOrder } from "@/lib/supabase/public.types";
import { PUBLIC_ORDER_COLUMNS } from "@/lib/supabase/public.types";
import type { OrderCardLine } from "./order-card";
import { OrderCard } from "./order-card";
import { OrderTabs } from "./order-tabs";

export const dynamic = "force-dynamic";

/** A restaurant's own history, newest first; older orders live in the ERP. */
const PAGE_SIZE = 50;

/** One line, plus the order it belongs to — the key this page groups on. */
type HistoryLine = OrderCardLine & { order_id: string };

export default async function OrdersPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: Locale }>;
  searchParams: Promise<{ created?: string; tab?: string }>;
}) {
  const { locale } = await params;
  const { created: rawCreated, tab: rawTab } = await searchParams;
  setRequestLocale(locale);
  const perf = perfRun(`/${locale}/pedidos`);
  const { supabase, pendingUser } = await beginCompanyUser(locale);
  const t = await getTranslations("orders");
  // The money and date vocabulary is the cart's, reused rather than duplicated
  // into a second namespace.
  const tCart = await getTranslations("cart");

  // `?created=` is user-editable and goes straight into the banner, so it is a
  // plain order number or no banner at all.
  const created = parseOrderNumber(rawCreated);
  // …and `?tab=` reaches `.in("status", …)`, so it is checked against the four
  // views this screen offers before it can select anything.
  const tab: CustomerOrderTab =
    typeof rawTab === "string" && isCustomerOrderTab(rawTab) ? rawTab : "all";

  // The profile row and the owner's price switch race; neither waits on the
  // other.
  const [portalUser, showPrices] = await Promise.all([
    finishCompanyUser(pendingUser, locale),
    perf.step("settings", getSetting(supabase, "show_prices")),
  ]);

  // The history itself is keyed by `company_id`, so it is the one read here that
  // has to wait for the profile row — same trade as `/direcciones`, and the same
  // answer: `orders_read` would narrow it anyway, and the explicit filter is
  // worth the round trip on a page that is opened once after an order.
  let query = supabase
    .from("orders")
    // The enumerated customer-readable list (CLAUDE.md: never `select('*')`
    // from orders — `staff_note` is column-revoked and a star select 403s).
    .select(PUBLIC_ORDER_COLUMNS)
    // Belt: `orders_read` already narrows this to the caller's company.
    // Suspenders: the filter says out loud whose orders this page is for.
    .eq("company_id", portalUser.company_id)
    .order("created_at", { ascending: false })
    .limit(PAGE_SIZE);
  // `all` is the absence of a filter, which is why it is not a status — the
  // staff queue's tab row works the same way.
  const statuses = statusesForTab(tab);
  if (statuses) query = query.in("status", statuses);

  const { data, error } = await perf.step("orders", query);
  if (error) console.error("orders query:", error);
  const orders: PublicOrder[] = data ?? [];

  // TWO more reads for the whole page, not two per card. The lines are what the
  // cards count, list and reorder from; the photos are the one live thing on a
  // card, looked up separately because the order's snapshot has never carried
  // an image. Both are `.in(…)` over every order on screen, so a history of
  // fifty costs the same three round trips as a history of one — and an empty
  // page (a filter with no matches, a restaurant's first visit) skips both.
  const orderIds = orders.map((order) => order.id);
  const linesByOrder = new Map<string, OrderCardLine[]>();
  const images = new Map<string, string | null>();

  if (orderIds.length > 0) {
    // `order_items` is customer-readable: `order_items_read` admits a line whose
    // PARENT order belongs to the caller's company (migration 20260815101406).
    // One string literal, never a concatenation: supabase-js types the row from
    // the literal, and `"a, " + "b"` widens to `string` and loses it.
    const itemResult = await perf.step(
      "lines",
      supabase
        .from("order_items")
        .select(
          "order_id, product_id, codart, name, qty, unit, units_per_case, line_total_cents",
        )
        .in("order_id", orderIds)
        // Ordered by a column this select does not ask for, which PostgREST
        // allows: `sort_order` is how the customer built the order, and it is
        // the order the panel and the photo strip both read in.
        .order("sort_order", { ascending: true }),
    );
    if (itemResult.error) console.error("order lines query:", itemResult.error);

    const lines: HistoryLine[] = itemResult.data ?? [];
    for (const line of lines) {
      const group = linesByOrder.get(line.order_id);
      if (group) group.push(line);
      else linesByOrder.set(line.order_id, [line]);
    }

    // Distinct products only: fifty orders of the same six articles are six ids
    // on the wire. The customer-safe priced view, asked for nothing but the
    // photo — this page prices nothing from the catalogue, every amount on it is
    // the order's own snapshot.
    const productIds = [
      ...new Set(
        lines
          .map((line) => line.product_id)
          .filter((id): id is string => id != null),
      ),
    ];
    if (productIds.length > 0) {
      const thumbResult = await perf.step(
        "thumbs",
        supabase
          .from("products_priced")
          .select("id, image_url")
          .in("id", productIds),
      );
      if (thumbResult.error)
        console.error("order thumbs query:", thumbResult.error);
      for (const product of thumbResult.data ?? []) {
        // The view widens every column to `| null`; keying off the narrowed
        // value avoids a cast, exactly as the cart page does it.
        if (product.id) images.set(product.id, product.image_url);
      }
    }
  }
  perf.end();

  return (
    <AppShell
      locale={locale}
      user={{ name: portalUser.display_name ?? portalUser.companies.name }}
      showPrices={showPrices}
    >
      {/* The screen's title row and its way back UP the hierarchy: 我的订单 is
          reached from the account hub, and the tab bar's 我的 is lit on this
          route (`nav-tabs.ts`) — which means the bottom bar leads BACK here
          rather than out. The chevron is a 44px target with the glyph centred in
          it, pulled into the page gutter by `-ml-2.5` so the mark lines up with
          the cards below rather than the box around it. Same row as `/carrito`'s,
          deliberately: the mockup draws both screens with the same white header
          band, and this portal translates that band into an in-flow title row on
          the page's own ground, under the shell's real header. */}
      <div className="flex items-center gap-1 pt-3">
        <Link
          href={`/${locale}/cuenta`}
          aria-label={t("back")}
          className="-ml-2.5 flex size-11 shrink-0 items-center justify-center text-2xl leading-none text-ink-soft transition-colors hover:text-brand-ink"
        >
          ‹
        </Link>
        <h1 className="min-w-0 truncate text-lg font-bold">{t("title")}</h1>
      </div>

      <OrderTabs locale={locale} active={tab} />

      {created != null && (
        <p
          role="status"
          className="mt-3 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-800"
        >
          {tCart("success", { n: created })}
        </p>
      )}

      {orders.length === 0 ? (
        // Two different empty screens: a restaurant that has never ordered, and
        // a filter that happens to match nothing. "您还没有订单" under 已取消
        // would be a claim about the whole history that the chip beside it
        // contradicts.
        <p className={`${CARD} mt-3 p-10 text-center text-muted`}>
          {tab === "all" ? t("empty") : t("emptyTab")}
        </p>
      ) : (
        <ul className="mt-3 flex flex-col gap-3">
          {orders.map((order) => (
            <OrderCard
              key={order.id}
              locale={locale}
              order={order}
              lines={linesByOrder.get(order.id) ?? []}
              images={images}
              showPrices={showPrices}
              reorder={reorderIntoCart}
            />
          ))}
        </ul>
      )}
    </AppShell>
  );
}
