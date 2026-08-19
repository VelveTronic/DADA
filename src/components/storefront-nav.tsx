"use client";

import { useTranslations } from "next-intl";
import Link from "next/link";
import { CartNavLink } from "@/components/cart/cart-nav-link";
import { SearchIcon, ShopIcon } from "@/components/icons";
import { UserMenu } from "@/components/user-menu";
import { ICON_BTN, ICON_BTN_ACTIVE } from "@/components/ui";
import { usePathname } from "@/i18n/navigation";
import { activeTab } from "@/lib/nav-tabs";

/**
 * The storefront header's right-hand side: 商店, 搜索, 购物车, 用户 — icons only,
 * at 44px each, and on the DESKTOP only. Below `lg` the shell hides this row
 * and the bottom `TabBar` is the navigation (see `app-shell.tsx`); the four
 * icons and the four tabs point at the same four screens.
 *
 * A Client Component for ONE reason: `usePathname`. The active-route accent is
 * the only thing on this row a Server Component could not work out for itself,
 * and threading an `active` prop down from every page instead would mean five
 * pages that each have to remember to say where they are — and one that forgets.
 * The cart's live count and the dropdown's open state need the client anyway.
 *
 * next-intl's `usePathname` strips the locale prefix, so what `activeTab` reads
 * is `/catalogo`, not `/zh/catalogo`. WHICH of the four is lit is that one
 * function's answer (`lib/nav-tabs.ts`), shared with the tab bar and the demand
 * bar: two navigation rows for the same four screens cannot be allowed to
 * disagree about where the customer is.
 */
export function StorefrontNav({
  locale,
  /** The restaurant's own name, printed at the top of the account panel. */
  userName,
}: {
  locale: string;
  userName: string;
}) {
  const tab = activeTab(usePathname());
  const t = useTranslations("nav");

  return (
    // No `ml-auto`: the shell wraps this row and does the pushing, because on a
    // phone the wrapper is what is hidden and a hidden element pushes nothing.
    //
    // NAMED, because it is not the only `<nav>` a customer page has: the bottom
    // tab bar is one, the catalogue's rail and its pager are two more, and an
    // unlabelled landmark reaches a screen reader's list of them as a bare
    // "navigation" with nothing to tell it from the rest.
    <nav
      aria-label={t("headerLabel")}
      className="flex items-center gap-0.5 sm:gap-1"
    >
      <Link
        href={`/${locale}/catalogo`}
        aria-label={t("shop")}
        aria-current={tab === "catalog" ? "page" : undefined}
        className={tab === "catalog" ? ICON_BTN_ACTIVE : ICON_BTN}
      >
        <ShopIcon />
      </Link>

      {/* The loupe goes where the search BOX goes: `/buscar`, the screen that
          owns the keyboard, the recent terms and the result list. It used to
          point at `/catalogo?focus=search` — a parameter nothing has read since
          the catalogue's own box became a link — so the icon and the box are
          one control in two places again. */}
      <Link
        href={`/${locale}/buscar`}
        aria-label={t("search")}
        aria-current={tab === "search" ? "page" : undefined}
        className={tab === "search" ? ICON_BTN_ACTIVE : ICON_BTN}
      >
        <SearchIcon />
      </Link>

      <CartNavLink locale={locale} active={tab === "cart"} />

      <UserMenu locale={locale} userName={userName} active={tab === "account"} />
    </nav>
  );
}
