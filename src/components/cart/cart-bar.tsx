"use client";

import { useTranslations } from "next-intl";
import Link from "next/link";
import { usePathname } from "@/i18n/navigation";
import { formatEuros } from "@/lib/money";
import { activeTab } from "@/lib/nav-tabs";
import { useCart } from "./cart-provider";

/**
 * The DEMAND BAR: a black pill floating over the phone's tab bar while there is
 * something to submit — 订单 3 种 · 12 件 on the left, 去提交 on the right.
 *
 * It replaces the red pill that used to sit on the safe area, and the two
 * changes are the same change: this portal is a DEMAND LIST, not a checkout.
 * The one red control on the screen is now the submit button INSIDE the bar
 * rather than the bar itself, and the bar's own black is what keeps it from
 * competing with the row of red `+` buttons it floats over.
 *
 * **Where it shows: 分类 and 搜索, and nowhere else.** Those are the two screens
 * where goods are picked and where a running total is the number a restaurant is
 * actually watching. On `/carrito` it would be a link to the page it is on; on
 * 我的 there is nothing to add to and the design draws none (screen 05).
 *
 * **The subtotal is the page's own arithmetic or nothing.** The provider adds up
 * the prices the SERVER rendered on this page (`cartSubtotalCents` returns null
 * the moment one line is missing from that set), so a cart holding something off
 * the current catalogue page shows the counts alone rather than a total that
 * quietly drops a line. With the owner's price switch OFF the amount is gone
 * entirely — not a dash where the figure was, which would read as "we could not
 * work it out" rather than "prices are off".
 *
 * **去提交 is 38px, not the portal's 44px.** That is the design's own CTA height
 * inside a 50px bar, and it is the one place this repo's touch-target convention
 * knowingly yields: a 44px button would leave 3px of bar above and below it,
 * which is the bar's whole vertical slop spent on a control that is already the
 * largest thing on the phone's bottom edge, unmissable against black and with no
 * second control anywhere near it to be confused with. It clears WCAG 2.2 AA's
 * 24px minimum with room to spare.
 *
 * It reserves NO space in the flow. It is fixed, and its offset is written from
 * the tab bar's own anchor — `3.5rem` is that bar's `h-14`, `env(…)` is the same
 * safe area that bar pads itself by, and the half-rem on top is the gap the
 * design floats it by (7px of it visible, since the tab bar's hairline sits
 * above the 56px row). The pair therefore reaches 114px + the safe area up from
 * the glass, and the clearance for it is paid by the two screens this bar
 * actually appears on: `catalogo/page.tsx`, in the pane tail and the rail tail,
 * and `buscar/page.tsx`, in the sheet's own bottom padding. `app-shell.tsx`'s
 * `<main>` inset is NOT that — it is the tab bar's, on every customer page,
 * including the ones this bar never draws on.
 */
export function CartBar({
  locale,
  showPrices,
}: {
  locale: string;
  showPrices: boolean;
}) {
  const { count, units, subtotalCents } = useCart();
  const t = useTranslations("cart");
  // next-intl strips the locale prefix, so this is `/catalogo`, not `/zh/catalogo`.
  const tab = activeTab(usePathname());

  if (count === 0 || (tab !== "catalog" && tab !== "search")) return null;

  return (
    <div className="fixed inset-x-3.5 bottom-[calc(3.5rem+env(safe-area-inset-bottom)+0.5rem)] z-40 flex h-[50px] items-center justify-between rounded-xl bg-ink pl-4 pr-1.5 shadow-[0_10px_24px_-8px_rgba(28,25,23,.5)] lg:hidden">
      {/* 订单 — the bar's OWN word, deliberately not the tab's. The owner split
          the two on 2026-08-19: what floats here is the order being built
          (订单 / Pedido), while the tab underneath names the place it lives
          (购物车 / Carrito) — so the string is `cart.barTitle`, not
          `nav.tabCart`. The counts are one message so a translator keeps the
          two figures and their units in one sentence; `<n>` is the design's
          typography on the first of them (Archivo, 15px), which is a tag
          rather than a value because only a tag can carry markup through a
          translation. Both figures are `{…, number}` in the message: a bare
          argument is stringified, and a weighed cart's 345.504 件 has to reach
          a Spanish reader as 345,504 uds. — with a dot it is a different
          number entirely. */}
      {/* `min-w-0 truncate` against `shrink-0` on the button: a long Spanish
          summary with three figures on it (Pedido 12 art. · 345,5 uds. ·
          1.234,56 €) is wider than the 390px bar, and the half that must
          survive that is the way to submit. What is dropped first is the tail
          of the sentence — the amount — which is also the one figure the cart
          page repeats in full. */}
      <p className="min-w-0 truncate text-xs text-white">
        {t("barTitle")}{" "}
        {t.rich("barSummary", {
          lines: count,
          units,
          n: (chunks) => (
            <b className="font-num text-[15px] font-semibold">{chunks}</b>
          ),
        })}
        {showPrices && subtotalCents != null && (
          <span className="font-num tabular-nums">
            {" · "}
            {formatEuros(subtotalCents, locale)}
          </span>
        )}
      </p>

      {/* `rounded-[9px]` is the design's own radius for this one CTA — between
          BTN_PRIMARY's 10px and the bar's 12px shell. One control, so it stays
          a literal rather than becoming a token. */}
      <Link
        href={`/${locale}/carrito`}
        className="flex h-[38px] shrink-0 items-center rounded-[9px] bg-brand px-4 text-[13.5px] font-semibold text-white transition-colors hover:bg-brand-ink"
      >
        {t("goSubmit")}
      </Link>
    </div>
  );
}
