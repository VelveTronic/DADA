import type { Locale } from "next-intl";
import { getTranslations } from "next-intl/server";
import { cookies } from "next/headers";
import Image from "next/image";
import Link from "next/link";
import { signOut } from "@/app/actions/auth";
import { CART_COOKIE, parseCart } from "@/lib/cart";

/**
 * The frosted-glass recipe, in one place so seven pages cannot drift apart.
 * White at 72% over the warm-grey ground, a hairline border, a 14px backdrop
 * blur and the one card radius — the same four properties the header uses.
 */
export const GLASS_CARD =
  "rounded-[var(--radius-card)] border border-border bg-surface backdrop-blur-[14px]";

/** Text/number/date inputs and textareas. */
export const FIELD =
  "rounded-lg border border-border bg-white/70 px-3 py-2 text-ink placeholder:text-muted focus:border-brand focus:outline-none";

/** The one accent: brand red, white text. Every page's main action. */
export const BTN_PRIMARY =
  "rounded-lg bg-brand px-4 py-2 text-white transition-colors hover:bg-brand/90 disabled:cursor-not-allowed disabled:opacity-40";

/** Everything that is not the main action on its screen. */
export const BTN_QUIET =
  "rounded-lg border border-border bg-white/70 px-3 py-1.5 transition-colors hover:border-brand hover:text-brand";

/** A shell nav entry, and the logout button that sits beside them. */
const NAV_LINK = "text-sm text-muted transition-colors hover:text-brand";

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

  const links =
    nav === "staff"
      ? [
          { href: `/${locale}/staff/pedidos`, label: tStaff("ordersQueue") },
          { href: `/${locale}/staff/productos`, label: tStaff("products") },
        ]
      : [
          { href: `/${locale}/catalogo`, label: tNav("catalog") },
          { href: `/${locale}/pedidos`, label: tNav("orders") },
          {
            href: `/${locale}/carrito`,
            label: tCart("cartLink", {
              n: Object.keys(
                parseCart((await cookies()).get(CART_COOKIE)?.value),
              ).length,
            }),
          },
        ];

  return (
    <>
      <header className="sticky top-0 z-40 border-b border-border bg-background/85 backdrop-blur-[14px]">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-5 gap-y-2 px-4 py-3">
          <Link href={home} className="flex items-center gap-2">
            {/* Sized by CSS in its own square aspect; the width/height pair is
                only the intrinsic ratio, so a new export of the mark drops in
                with no code change. */}
            <Image
              src="/brand/dada-logo.png"
              alt="DADA"
              width={512}
              height={512}
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
