import { getTranslations } from "next-intl/server";
import Link from "next/link";
import type { CustomerOrderTab } from "@/lib/orders";
import { CUSTOMER_ORDER_TABS } from "@/lib/orders";

/**
 * The chip row at the top of 我的订单: 全部 / 进行中 / 已完成 / 已取消.
 *
 * **Four views, not seven states.** See `CUSTOMER_ORDER_TABS` — the three states
 * the bridge owns are grouped under 进行中 on purpose, because a restaurant has
 * no use for the difference and this row must not become a readout of our
 * plumbing. The mockup's own five chips (已提交 / 待配送 / 配送中 …) are exactly
 * the version of this that would.
 *
 * **The URL is the filter.** Every chip is a plain `<Link>` and every press is a
 * navigation, so a filtered history can be shared, bookmarked and reached with
 * the back button — the same rule the catalogue's rail and `/buscar` follow. It
 * also means the row needs no client JavaScript at all.
 *
 * 全部 links to the bare path rather than to `?tab=all`, so the default view has
 * ONE address. Every chip drops whatever else was in the query string, which is
 * what retires the `?created=` banner: that sentence belongs to the checkout
 * that just happened, not to the next tab the customer presses.
 *
 * The row scrolls sideways (`overflow-x-auto`) and bleeds into the page gutter
 * (`-mx-4 px-4`) so the last chip can reach the edge of the screen instead of
 * stopping short of it. Four chips fit a 390px phone today; the Spanish labels
 * are the longer pair and the row is built for them not fitting.
 */
export async function OrderTabs({
  locale,
  active,
}: {
  locale: string;
  active: CustomerOrderTab;
}) {
  const t = await getTranslations("orders");
  // Spelled out rather than `t(\`tab${…}\`)`: a computed message key is one
  // rename away from shipping the raw token to a customer, and these four are
  // the whole list.
  const label: Record<CustomerOrderTab, string> = {
    all: t("tabAll"),
    active: t("tabActive"),
    done: t("tabDone"),
    cancelled: t("tabCancelled"),
  };

  return (
    <nav
      aria-label={t("tabsLabel")}
      className="-mx-4 flex gap-2 overflow-x-auto px-4 py-1"
    >
      {CUSTOMER_ORDER_TABS.map((tab) => {
        const on = tab === active;
        return (
          <Link
            key={tab}
            href={
              tab === "all"
                ? `/${locale}/pedidos`
                : `/${locale}/pedidos?tab=${tab}`
            }
            // The lit chip is the page's current filter, which is what
            // `aria-current="page"` means — the same reading the catalogue's
            // rail gives its own active entry.
            aria-current={on ? "page" : undefined}
            className={`flex h-8 flex-none items-center whitespace-nowrap rounded-full px-3.5 text-[12.5px] transition-colors ${
              on
                ? "bg-brand font-semibold text-white"
                : "bg-surface-dim text-ink-soft hover:text-ink"
            }`}
          >
            {label[tab]}
          </Link>
        );
      })}
    </nav>
  );
}
