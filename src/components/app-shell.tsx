import type { Locale } from "next-intl";
import { cookies } from "next/headers";
import Image from "next/image";
import Link from "next/link";
import { CartBar } from "@/components/cart/cart-bar";
import { CartErrorBanner, CartProvider } from "@/components/cart/cart-provider";
import { StorefrontNav } from "@/components/storefront-nav";
import { TabBar } from "@/components/tab-bar";
import { CART_COOKIE, parseCart } from "@/lib/cart";

/**
 * The storefront's sticky header, the page's `<main>` and the phone's two
 * floating bars, for every signed-in CUSTOMER page, in one of two LAYOUTS.
 *
 * ```text
 *   layout="page"                    layout="viewport"
 *   ─────────────────────            ─────────────────────
 *   header (sticky)                  ┌ flex h-dvh flex-col ┐
 *   main  px-4 pb-…                  │ header   flex-none  │
 *   …the document scrolls            │ main     flex-1     │  …the PAGE scrolls
 *   ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌             └ min-h-0 ────────────┘     its own panes
 *   CartBar   ┐ fixed, below `lg`, out of flow in BOTH layouts:
 *   TabBar    ┘ neither is a flex child of anything
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
 * **The bottom 114px of a phone belongs to the two bars**: a 56px `TabBar` on
 * the safe area and, while the cart has something in it, the 50px demand bar
 * floating just above it. Both are `position: fixed`, so they are out of flow —
 * they cost the height chain nothing and reserve nothing either, which is why
 * the clearance is bottom padding on the content instead: `<main>`'s own in
 * `"page"` mode below, and the pane tail in `catalogo/page.tsx` in `"viewport"`
 * mode, where `<main>` has no insets at all.
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
 * kept only the half it is actually about: the DADA mark and the way to every
 * other screen. That way is now TWO controls for two devices, and exactly one
 * of them is ever on screen: the header's icon row (商店, 搜索, 购物车, 用户,
 * the last of which opens the account menu holding 我的订单 and the way out) on
 * `lg` and up, and the bottom tab bar below it. The word 订货平台 is gone from
 * the header: a storefront header carries the BRAND, and the app's full name
 * still names the browser tab (`common.appName` in `layout.tsx`) and titles the
 * login page.
 *
 * Server component: nothing it renders itself is interactive; the icon row and
 * the tab bar are client leaves. It wraps the page in `CartProvider` and hands
 * the cart's four client leaves — the header count, the tab bar's badge, the
 * refusal banner and the demand bar — the cookie it just read.
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
        {/* One row that never wraps: the mark on the left, and on the right
            EITHER the restaurant's name (phone) or the icon row (desktop) —
            never both, and never wrapped. The phone's navigation moved to the
            bottom of the screen (`TabBar`), which is what frees this row to say
            WHOSE portal this is; on `lg` the icons come back and the name goes,
            because that row is still the desktop's only way around. */}
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

          {/* The restaurant, beside the brand, on the phone only. Capped at 45%
              of the row and truncated: these names run long (a shop name, a dot
              and a branch), and the one thing this row may never do is push the
              mark off the left of the screen. */}
          <span className="ml-auto max-w-[45%] truncate text-xs text-muted lg:hidden">
            {user.name}
          </span>

          {/* `ml-auto` is on the WRAPPER now, not on the nav inside it: the nav
              is `display:none` below `lg`, and a hidden element pushes nothing.
              At `lg` the span above is the hidden one — which takes no width and
              opens no `gap` — so this row is the desktop header exactly as it
              was. */}
          <div className="ml-auto hidden lg:flex">
            <StorefrontNav locale={locale} userName={user.name} />
          </div>
        </div>
      </header>

      {/* In viewport mode `<main>` carries NO insets: the catalogue's panes run
          edge to edge (the rail's own fill is the left gutter) and each half of
          it pads its own contents.

          In page mode the bottom inset is the phone's TAB BAR plus a finger's
          breathing room: `4.5rem + env(safe-area-inset-bottom)` is 72px + the
          inset, against a bar that is 57px + the same inset (1px of hairline,
          a 56px row, and the safe area as padding under it) — 15px of air, so
          the last card on a page is never pinned against a fixed control. The
          desktop keeps the 64px it always had: no tab bar there.

          It is the inset for the TAB BAR only, and the demand bar is nobody's
          business here — the two screens that float one (`/catalogo`,
          `/buscar`) each answer for it themselves, in different places.
          `/catalogo` never receives this padding at all: it is the viewport
          layout, where `<main>` has no insets, and its pane tail provides the
          whole 120px + inset on its own. `/buscar` IS in page mode and does
          receive it — but its sheet's own `pb-36` sits INSIDE `<main>`, i.e.
          above this padding rather than instead of it, so that screen's last
          row has both. See the note on the sheet in `buscar/page.tsx`. */}
      <main
        className={
          viewport
            ? "mx-auto flex w-full max-w-5xl min-h-0 flex-1 flex-col"
            : "mx-auto max-w-5xl px-4 pb-[calc(4.5rem+env(safe-area-inset-bottom))] lg:pb-16"
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
      </main>

      {/* Outside `<main>`, which holds the page's CONTENT: these two are fixed
          furniture over it. The demand bar used to live in there and reserve
          its own 80px with an in-flow spacer — a real fourth flex child of the
          catalogue's column, which laid its panes out 80px short. Nothing here
          is in flow any more, so nothing distorts that column; the clearance is
          the content's own padding now. Written in the order they stack. */}
      <CartBar locale={locale} showPrices={showPrices} />
      <TabBar locale={locale} />
    </>
  );

  return (
    <CartProvider cart={cart} prices={cartPrices ?? {}}>
      {viewport ? <div className="flex h-dvh flex-col">{frame}</div> : frame}
    </CartProvider>
  );
}
