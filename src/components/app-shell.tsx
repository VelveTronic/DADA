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
 * CUSTOMER page, in one of two LAYOUTS.
 *
 * ```text
 *   layout="page"                    layout="viewport"
 *   ─────────────────────            ─────────────────────
 *   header (sticky)                  ┌ flex h-dvh flex-col ┐
 *   main  px-4 pb-16                 │ header   flex-none  │
 *   …the document scrolls            │ main     flex-1     │  …the PAGE scrolls
 *                                    └ min-h-0 ────────────┘     its own panes
 * ```
 *
 * `"page"` is the whole portal: one scrolling document, insets on `<main>`.
 * `"viewport"` is the catalogue, and only the catalogue — the two-pane
 * 分类点货 screen, where the rail and the product list scroll SEPARATELY and
 * neither may push the document taller than the phone. That needs a height
 * chain with no gaps in it: `h-dvh` on the frame, `flex-none` on the header,
 * `min-h-0 flex-1` on `<main>` (without `min-h-0` a flex child refuses to
 * shrink below its content and the panes push the page down instead of
 * scrolling), and the page's own panes carry it the last step.
 *
 * One wrinkle that is temporary: until Task 5 removes the old red `CartBar`, its
 * in-flow `h-20 lg:hidden` spacer is a FOURTH flex child of `<main>` on a phone
 * whose cart is not empty, so on those requests the catalogue's panes are laid
 * out 80px shorter than they otherwise would be. Task 5 deletes that bar and
 * takes the spacer with it.
 *
 * `h-dvh` rather than `h-screen`: on a phone the address bar grows and shrinks
 * the viewport, and `dvh` is the unit that follows it.
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
  layout = "page",
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
  /**
   * `"page"` (the default) is today's scrolling document. `"viewport"` pins the
   * shell to the phone's height so the page can scroll panes of its own — see
   * the diagram above. Only `/catalogo` asks for it.
   */
  layout?: "page" | "viewport";
  children: React.ReactNode;
}) {
  const cart = parseCart((await cookies()).get(CART_COOKIE)?.value);
  const viewport = layout === "viewport";

  // Header and main are built once and WRAPPED only in viewport mode, rather
  // than wrapped always in a `display:contents` div: `"page"` then renders the
  // exact element tree it did before this prop existed.
  const frame = (
    <>
      {/* Solid white on the beige ground, not tinted glass: the header is a
          SURFACE in this design, the same white as the cards under it, and the
          hairline is what separates the two. Dropping the `backdrop-filter` also
          drops the containing block it silently created for `fixed`
          descendants — see the note in `staff-sidebar.tsx`. */}
      <header
        className={`sticky top-0 z-40 border-b border-border bg-surface${
          viewport ? " flex-none" : ""
        }`}
      >
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

      {/* In viewport mode `<main>` carries NO insets: the catalogue's panes run
          edge to edge (the rail's own fill is the left gutter) and each half of
          it pads its own contents. */}
      <main
        className={
          viewport
            ? "mx-auto flex w-full max-w-5xl min-h-0 flex-1 flex-col"
            : "mx-auto max-w-5xl px-4 pb-16"
        }
      >
        {/* Where the `?cartError` banner used to land after a redirect. Same
            copy, same red, no round trip to get here — and in viewport mode it
            borrows the gutter the page dropped, so a refusal is not flush
            against the screen edge. The wrapper is empty (and 0px tall) on the
            requests that have no error to show. */}
        {viewport ? (
          <div className="flex-none px-4">
            <CartErrorBanner />
          </div>
        ) : (
          <CartErrorBanner />
        )}
        {children}
        <CartBar locale={locale} showPrices={showPrices} />
      </main>
    </>
  );

  return (
    <CartProvider cart={cart} prices={cartPrices ?? {}}>
      {viewport ? <div className="flex h-dvh flex-col">{frame}</div> : frame}
    </CartProvider>
  );
}
