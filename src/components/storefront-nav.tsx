"use client";

import { useTranslations } from "next-intl";
import Link from "next/link";
import { CartNavLink } from "@/components/cart/cart-nav-link";
import { SearchIcon, ShopIcon } from "@/components/icons";
import { UserMenu } from "@/components/user-menu";
import { ICON_BTN, ICON_BTN_ACTIVE } from "@/components/ui";
import { usePathname } from "@/i18n/navigation";

/** The pages behind the 用户 menu; the trigger stays lit while on any of them. */
const ACCOUNT_PATHS = ["/pedidos", "/direcciones", "/perfil"];

/**
 * The storefront header's right-hand side: 商店, 搜索, 购物车, 用户 — icons only,
 * at 44px each, on the phone exactly as on the desktop.
 *
 * A Client Component for ONE reason: `usePathname`. The active-route accent is
 * the only thing on this row a Server Component could not work out for itself,
 * and threading an `active` prop down from every page instead would mean five
 * pages that each have to remember to say where they are — and one that forgets.
 * The cart's live count and the dropdown's open state need the client anyway.
 *
 * next-intl's `usePathname` strips the locale prefix, so the comparisons below
 * are against `/catalogo`, not `/zh/catalogo` — the same idiom `cart-bar.tsx`
 * uses to hide itself on the cart page.
 */
export function StorefrontNav({
  locale,
  /** The restaurant's own name, printed at the top of the account panel. */
  userName,
}: {
  locale: string;
  userName: string;
}) {
  const pathname = usePathname();
  const t = useTranslations("nav");

  return (
    <nav className="ml-auto flex items-center gap-0.5 sm:gap-1">
      <Link
        href={`/${locale}/catalogo`}
        aria-label={t("shop")}
        aria-current={pathname === "/catalogo" ? "page" : undefined}
        className={pathname === "/catalogo" ? ICON_BTN_ACTIVE : ICON_BTN}
      >
        <ShopIcon />
      </Link>

      {/* Today this is a link to the CATALOGUE, and `?focus=search` on it is
          inert: the catalogue's own search box became a link to `/buscar`, and
          nothing reads a `focus` parameter any more — the page's `searchParams`
          type names `tab`, `page` and `cat` only. The href is left exactly as it
          is on purpose; Task 5 repoints this icon at `/buscar`, the screen that
          owns searching, and drops the dead parameter with it. */}
      <Link
        href={`/${locale}/catalogo?focus=search`}
        aria-label={t("search")}
        className={ICON_BTN}
      >
        <SearchIcon />
      </Link>

      <CartNavLink locale={locale} active={pathname === "/carrito"} />

      <UserMenu
        locale={locale}
        userName={userName}
        active={ACCOUNT_PATHS.includes(pathname)}
      />
    </nav>
  );
}
