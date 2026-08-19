"use client";

import { useTranslations } from "next-intl";
import Link from "next/link";
import { CartIcon } from "@/components/icons";
import { ICON_BTN, ICON_BTN_ACTIVE } from "@/components/ui";
import { useCart } from "./cart-provider";

/**
 * The header's cart entry: the basket icon, and the count as a badge on it.
 *
 * Still a client leaf for the same reason it always was — it ticks on the press
 * rather than on the next navigation, because `useCart` mirrors the cookie the
 * moment a `+` is pressed anywhere under the shell.
 *
 * It counts LINES, not units (`cart.cartLink` takes `{n}`): "购物车（3）" means
 * three products, whatever the quantities are. That sentence is now the icon's
 * ARIA LABEL rather than its visible text — the badge shows the same number, and
 * a screen reader needs the noun as much as the figure. An empty cart still
 * announces "购物车（0）"; the badge is simply not drawn.
 */
export function CartNavLink({
  locale,
  /** True on `/carrito` itself, so the row's one accent rule holds here too. */
  active,
}: {
  locale: string;
  active: boolean;
}) {
  const { count } = useCart();
  const t = useTranslations("cart");

  return (
    <Link
      href={`/${locale}/carrito`}
      aria-label={t("cartLink", { n: count })}
      aria-current={active ? "page" : undefined}
      className={active ? ICON_BTN_ACTIVE : ICON_BTN}
    >
      <CartIcon />
      {count > 0 && (
        // Hidden from the accessibility tree: the label above already says the
        // number, and announcing "3" a second time as a bare digit is noise.
        // `tabular-nums` keeps the pill from jumping between 9 and 10.
        <span
          aria-hidden="true"
          className="absolute top-1 right-1 inline-flex min-w-5 items-center justify-center rounded-full bg-brand px-1 text-[11px] leading-5 font-semibold text-white tabular-nums"
        >
          {count}
        </span>
      )}
    </Link>
  );
}
