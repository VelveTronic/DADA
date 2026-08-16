import type { Locale } from "next-intl";
import { getTranslations } from "next-intl/server";
import { cookies } from "next/headers";
import Image from "next/image";
import Link from "next/link";
import { signOut } from "@/app/actions/auth";
import { CartBar } from "@/components/cart/cart-bar";
import { CartNavLink } from "@/components/cart/cart-nav-link";
import { CartErrorBanner, CartProvider } from "@/components/cart/cart-provider";
import { NAV_LINK } from "@/components/ui";
import { CART_COOKIE, parseCart } from "@/lib/cart";
import { canManageStaff, canManageUsers } from "@/lib/user-admin";

type NavLink = { href: string; label: string };

/**
 * Who is signed in. `role` is the staff member's `staff_users.role`; customers
 * have none — the restaurant's own name is already the whole label.
 *
 * It arrives as the ROLE rather than as a pre-formatted caption because the
 * shell now asks it a question as well as printing it: whether this staff
 * member sees 用户管理 in the nav. One field, one source — a page cannot show
 * the link while captioning a different role. `user-admin` is a pure module
 * with no imports, so a Server Component may hold it as safely as a lib.
 */
type ShellUser = { name: string; role?: string | null };

/**
 * The sticky glass header plus the page's `<main>`, for every signed-in page.
 *
 * Each page used to hand-roll its own title row, its own back link and its own
 * logout form, which is why the brand mark, the app name and the way out now
 * live here exactly once. The two variants differ only in where the brand mark
 * points and which links follow it:
 *
 * - `customer` — catalogue, order history, cart (with its line count)
 * - `staff` — confirmation queue, product management
 *
 * Server component: the only interactive thing IT renders is the logout form.
 * The customer variant additionally wraps the page in `CartProvider` and hands
 * the cart's three client leaves — the header count, the refusal banner and the
 * phone's bottom bar — the cookie it just read. Staff pages mount none of it:
 * there is no cart in that half of the portal, so there is no reason to ship it.
 *
 * A page may READ the cart cookie; only the cart server actions write it. The
 * read below seeds the provider, and it is the reason every page under this
 * shell is `force-dynamic` already.
 */
export async function AppShell({
  locale,
  nav,
  user,
  cartPrices,
  showPrices = true,
  children,
}: {
  locale: Locale;
  nav: "customer" | "staff";
  user: ShellUser;
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
   * Defaults to TRUE, and that default is the fail-open rule again rather than
   * convenience: staff pages pass nothing (they have no cart bar and always show
   * prices), and a customer page that somehow forgot to pass it shows prices, as
   * it did before this setting existed.
   */
  showPrices?: boolean;
  children: React.ReactNode;
}) {
  const tc = await getTranslations("common");
  const tNav = await getTranslations("nav");
  const tStaff = await getTranslations("staff");

  const home = nav === "staff" ? `/${locale}/staff` : `/${locale}/catalogo`;
  const customer = nav === "customer";

  const cart = customer
    ? parseCart((await cookies()).get(CART_COOKIE)?.value)
    : {};

  const links: NavLink[] = customer
    ? [
        { href: `/${locale}/catalogo`, label: tNav("catalog") },
        { href: `/${locale}/pedidos`, label: tNav("orders") },
      ]
    : [
        { href: `/${locale}/staff/pedidos`, label: tStaff("ordersQueue") },
        { href: `/${locale}/staff/productos`, label: tStaff("products") },
        // Manager and owner only. Hiding it is a courtesy, not the gate: the
        // page re-checks with `requireStaff` + `canManageUsers` and so does
        // every action behind it, because a nav array cannot stop a POST.
        ...(canManageUsers(user.role)
          ? [{ href: `/${locale}/staff/usuarios`, label: tStaff("usersAdmin") }]
          : []),
        // Owner only — 项目设置 changes what EVERY restaurant sees, so it is the
        // narrower of the two gates. Same courtesy/gate split as above: the page
        // redirects a manager back to /staff and `updateSetting` throws.
        ...(canManageStaff(user.role)
          ? [{ href: `/${locale}/staff/ajustes`, label: tStaff("settingsAdmin") }]
          : []),
      ];

  const shell = (
    <>
      <header className="sticky top-0 z-40 border-b border-border bg-background/85 backdrop-blur-[14px]">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-5 gap-y-2 px-4 py-3">
          <Link href={home} className="flex items-center gap-2">
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
            <span className="font-semibold tracking-tight">
              {tc("appName")}
            </span>
          </Link>

          <nav className="flex flex-wrap items-center gap-x-5 gap-y-1">
            {links.map((link) => (
              <Link key={link.href} href={link.href} className={NAV_LINK}>
                {link.label}
              </Link>
            ))}
            {/* Same label and same count as before, now read from the provider
                so a `+` on the catalogue ticks it without a navigation. */}
            {customer && <CartNavLink locale={locale} />}
          </nav>

          <div className="ml-auto flex items-center gap-4">
            <span className="max-w-[12rem] truncate text-xs text-muted">
              {user.name}
              {user.role ? ` · ${user.role}` : ""}
            </span>
            <form action={signOut}>
              <input type="hidden" name="locale" value={locale} />
              <button type="submit" className={NAV_LINK}>
                {tc("logout")}
              </button>
            </form>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 pb-16">
        {/* Where the `?cartError` banner used to land after a redirect. Same
            copy, same red, no round trip to get here. */}
        {customer && <CartErrorBanner />}
        {children}
        {customer && <CartBar locale={locale} showPrices={showPrices} />}
      </main>
    </>
  );

  if (!customer) return shell;

  return (
    <CartProvider cart={cart} prices={cartPrices ?? {}}>
      {shell}
    </CartProvider>
  );
}
