import type { Locale } from "next-intl";
import { cookies } from "next/headers";
import Image from "next/image";
import Link from "next/link";
import { CartBar } from "@/components/cart/cart-bar";
import { CartErrorBanner, CartProvider } from "@/components/cart/cart-provider";
import { StorefrontNav } from "@/components/storefront-nav";
import { CART_COOKIE, parseCart } from "@/lib/cart";

/**
 * The storefront's sticky header plus the page's `<main>`, for every signed-in
 * CUSTOMER page.
 *
 * Each page used to hand-roll its own title row, its own back link and its own
 * logout form, which is why the brand mark, the app name and the way out now
 * live here exactly once.
 *
 * It used to serve the staff pages too, behind a `nav` prop, and it no longer
 * does: the two halves had stopped sharing anything but the `<main>` element.
 * Staff pages render `StaffShell` — a persistent left sidebar — and this file
 * kept only the half it is actually about: the DADA mark and four ICONS
 * (商店, 搜索, 购物车, 用户), the last of which opens the account menu that holds
 * 我的订单 and the way out. The word 订货平台 is gone from it: a storefront
 * header carries the BRAND, and the app's full name still names the browser tab
 * (`common.appName` in `layout.tsx`) and titles the login page.
 *
 * Server component: nothing it renders itself is interactive; the icon row is
 * one client leaf (`StorefrontNav`). It wraps the page in `CartProvider` and
 * hands the cart's three client leaves — the header count, the refusal banner
 * and the phone's bottom bar — the cookie it just read.
 *
 * A page may READ the cart cookie; only the cart server actions write it. The
 * read below seeds the provider, and it is the reason every page under this
 * shell is `force-dynamic` already.
 */
export async function AppShell({
  locale,
  user,
  cartPrices,
  showPrices = true,
  children,
}: {
  locale: Locale;
  /** The restaurant's own name — it is already the whole label. */
  user: { name: string };
  /**
   * Price of one CAJA in cents for the products THIS page rendered, keyed by
   * product id — the mobile bar's only source of money, and the unit the cart's
   * quantities are counted in. Omitted by pages that price nothing (order
   * history) and by any page rendering with `showPrices` false, which is why the
   * bar can fall back to a count.
   */
  cartPrices?: Record<string, number>;
  /**
   * The owner's `show_prices` setting, as the page read it. Only the mobile cart
   * bar needs it here — every other amount is rendered by the page itself, which
   * simply omits the markup.
   *
   * Defaults to TRUE, and that default is the fail-open rule rather than
   * convenience: a page that somehow forgot to pass it shows prices, as it did
   * before this setting existed.
   */
  showPrices?: boolean;
  children: React.ReactNode;
}) {
  const cart = parseCart((await cookies()).get(CART_COOKIE)?.value);

  return (
    <CartProvider cart={cart} prices={cartPrices ?? {}}>
      {/* Solid white on the beige ground, not tinted glass: the header is a
          SURFACE in this design, the same white as the cards under it, and the
          hairline is what separates the two. Dropping the `backdrop-filter` also
          drops the containing block it silently created for `fixed`
          descendants — see the note in `staff-sidebar.tsx`. */}
      <header className="sticky top-0 z-40 border-b border-border bg-surface">
        {/* One row that never wraps: mark on the left, icons pinned right. No
            `flex-wrap` here on purpose — four 44px targets and a wordmark fit
            inside 375px, and a wrapping header would push the catalogue down a
            line on exactly the phones this layout is for. */}
        <div className="mx-auto flex max-w-5xl items-center gap-3 px-4 py-2">
          <Link
            href={`/${locale}/catalogo`}
            className="flex items-center gap-2 transition-colors hover:text-brand-ink"
          >
            {/* Sized by CSS in its own square aspect; the width/height pair is
                only the intrinsic ratio, so a new export of the mark drops in
                with no code change. `sizes` is what keeps the optimizer from
                shipping a 1080px source for a 28px mark. */}
            <Image
              src="/brand/dada-logo.png"
              alt="DADA"
              width={512}
              height={512}
              sizes="28px"
              className="h-7 w-7"
            />
            {/* The BRAND, not the app name. `alt="DADA"` above says the same
                word, so the mark is decorative beside it — but an empty alt
                would make the link's whole name depend on this span, and it
                is the one thing here that could be styled away. */}
            <span className="text-lg font-semibold tracking-tight">DADA</span>
          </Link>

          <StorefrontNav locale={locale} userName={user.name} />
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 pb-16">
        {/* Where the `?cartError` banner used to land after a redirect. Same
            copy, same red, no round trip to get here. */}
        <CartErrorBanner />
        {children}
        <CartBar locale={locale} showPrices={showPrices} />
      </main>
    </CartProvider>
  );
}
