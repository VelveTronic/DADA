import type { Locale } from "next-intl";
import { getTranslations } from "next-intl/server";
import { cookies } from "next/headers";
import Image from "next/image";
import Link from "next/link";
import { signOut } from "@/app/actions/auth";
import { CART_COOKIE, parseCart } from "@/lib/cart";

/** A shell nav entry, and the logout button that sits beside them. */
const NAV_LINK = "text-sm text-muted transition-colors hover:text-brand-ink";

/** The same entry once it has something to say — today, a non-empty cart. */
const NAV_PILL =
  "rounded-full bg-brand-soft px-2.5 py-1 text-sm text-brand-ink transition-colors hover:bg-brand hover:text-white";

type NavLink = { href: string; label: string; highlight?: boolean };

/**
 * Who is signed in. `detail` is the staff member's role; customers have none —
 * the restaurant's own name is already the whole label.
 */
type ShellUser = { name: string; detail?: string | null };

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
 * Server component: the only interactive thing in it is the logout form, which
 * posts to the same `signOut` action the pages used to carry themselves.
 *
 * A page may READ the cart cookie; only the cart server actions write it. The
 * read below is the count in the header link, and it is the reason every page
 * under this shell is `force-dynamic` already.
 */
export async function AppShell({
  locale,
  nav,
  user,
  children,
}: {
  locale: Locale;
  nav: "customer" | "staff";
  user: ShellUser;
  children: React.ReactNode;
}) {
  const tc = await getTranslations("common");
  const tNav = await getTranslations("nav");
  const tCart = await getTranslations("cart");
  const tStaff = await getTranslations("staff");

  const home = nav === "staff" ? `/${locale}/staff` : `/${locale}/catalogo`;

  const cartCount =
    nav === "customer"
      ? Object.keys(parseCart((await cookies()).get(CART_COOKIE)?.value)).length
      : 0;

  const links: NavLink[] =
    nav === "staff"
      ? [
          { href: `/${locale}/staff/pedidos`, label: tStaff("ordersQueue") },
          { href: `/${locale}/staff/productos`, label: tStaff("products") },
        ]
      : [
          { href: `/${locale}/catalogo`, label: tNav("catalog") },
          { href: `/${locale}/pedidos`, label: tNav("orders") },
          // Same label, same count, in the brand's soft tint once there is
          // something in it — a cart nobody can see is a cart nobody submits.
          {
            href: `/${locale}/carrito`,
            label: tCart("cartLink", { n: cartCount }),
            highlight: cartCount > 0,
          },
        ];

  return (
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
              <Link
                key={link.href}
                href={link.href}
                className={link.highlight ? NAV_PILL : NAV_LINK}
              >
                {link.label}
              </Link>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-4">
            <span className="max-w-[12rem] truncate text-xs text-muted">
              {user.name}
              {user.detail ? ` · ${user.detail}` : ""}
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

      <main className="mx-auto max-w-5xl px-4 pb-16">{children}</main>
    </>
  );
}
