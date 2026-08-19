"use client";

import { useTranslations } from "next-intl";
import Link from "next/link";
import { useCart } from "@/components/cart/cart-provider";
import { usePathname } from "@/i18n/navigation";
import { activeTab, type TabKey } from "@/lib/nav-tabs";

/**
 * The phone's bottom TAB BAR: 分类 · 搜索 · 购物车 · 我的, the four screens this
 * portal is, one press apart at the bottom of the glass.
 *
 * It is the design's answer to a header the customer had to reach the top
 * corner of. The storefront header keeps its icon row on the DESKTOP (`lg` and
 * up, where a mouse makes the corner free and a 74px bar across the bottom of a
 * 1440px window would be absurd); on a phone that row is hidden and this is the
 * navigation — see `app-shell.tsx`, which draws exactly one of the two.
 *
 * **Hidden on `/carrito` entirely.** That screen's own bottom edge belongs to
 * 提交需求单 (design 02), and a tab bar under a submit button is one press too
 * many next to the one press that matters. Every other customer screen has it,
 * including the ones with no tab of their own — `activeTab` answers null there
 * and nothing is lit.
 *
 * It never renders for a signed-out visitor: the only page with no `AppShell`
 * is the login screen (see the note in `login/page.tsx`), and staff pages
 * render `StaffShell` instead.
 *
 * `fixed`, so it is out of flow and cannot be a flex child of the catalogue's
 * height chain. What that costs is a page's LAST row disappearing under it, and
 * every page pays it in bottom padding: the shell's `<main>` in `"page"` mode,
 * and the catalogue's own pane tail in `"viewport"` mode.
 */

/**
 * The four glyphs, at the design's 17px, drawn here rather than in `icons.tsx`
 * for the reason `cuenta/page.tsx` draws its own: that module is the NAV
 * VOCABULARY — one 24-unit grid rendered at `size-6` in the header and the staff
 * sidebar — and these are a different grid at a different size, used nowhere
 * else. Same two contracts as those, though: the colour comes from the anchor
 * (`currentColor`, so the active rule below reaches the icon without the icon
 * knowing anything about state), and `aria-hidden`, because the label under it
 * is the tab's name.
 *
 * All four carry a `Tab` prefix, and that is what the split above costs in
 * names: `icons.tsx` draws its own loupe and basket-adjacent glyphs on the
 * 24-unit grid, and two glyphs of one name in one repo — one exported, one
 * local — would be told apart only by which import a file happened to have.
 * The prefix says which vocabulary a glyph belongs to at every use site.
 * Local to this file; nothing here is exported.
 */
const ICON = {
  viewBox: "0 0 17 17",
  className: "size-[17px]",
  "aria-hidden": true,
} as const;

/**
 * All four are drawn in ONE style — 1.7px strokes, round caps — because the
 * first cut mixed a filled grid with three outline glyphs, and the owner read
 * the odd ones as broken (a loupe with no handle is "a circle", shoulders with
 * no head are "a headless person"). Each mark now carries the part that names
 * it: the handle on the loupe, the handle and taper on the basket, the head on
 * the person. Redrawn on the owner's review, 2026-08-19.
 */
const STROKE = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.7,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

/** 分类 — the 2×2 grid every catalogue in this market uses. */
function TabGridIcon() {
  return (
    <svg {...ICON} {...STROKE}>
      <rect x="1.1" y="1.1" width="6.1" height="6.1" rx="1.7" />
      <rect x="9.8" y="1.1" width="6.1" height="6.1" rx="1.7" />
      <rect x="1.1" y="9.8" width="6.1" height="6.1" rx="1.7" />
      <rect x="9.8" y="9.8" width="6.1" height="6.1" rx="1.7" />
    </svg>
  );
}

/** 搜索 — the loupe: lens up and left, handle down to the corner. */
function TabLoupeIcon() {
  return (
    <svg {...ICON} {...STROKE}>
      <circle cx="7.3" cy="7.3" r="4.9" />
      <path d="m11.1 11.1 4.2 4.2" />
    </svg>
  );
}

/** 购物车 — the shopping basket: a tapered body under an arched handle. */
function TabBasketIcon() {
  return (
    <svg {...ICON} {...STROKE}>
      <path d="M2.1 6.3h12.8l-1.35 6.8a2.5 2.5 0 0 1-2.45 2H5.9a2.5 2.5 0 0 1-2.45-2Z" />
      <path d="M5.4 6.3 8.5 2l3.1 4.3" />
    </svg>
  );
}

/** 我的 — head and shoulders, head included. */
function TabPersonIcon() {
  return (
    <svg {...ICON} {...STROKE}>
      <circle cx="8.5" cy="4.9" r="3.2" />
      <path d="M2.5 15.9a6 5.8 0 0 1 12 0" />
    </svg>
  );
}

/**
 * The row, in the design's order. `as const satisfies` rather than a plain
 * annotation: the shape is checked here (a `key` that is not a `TabKey` could
 * never light), and the label keys stay LITERAL, so a typo in one is a
 * compile error against the message file rather than a raw key on the glass.
 */
const TABS = [
  { key: "catalog", path: "catalogo", label: "tabCatalog", Icon: TabGridIcon },
  { key: "search", path: "buscar", label: "tabSearch", Icon: TabLoupeIcon },
  { key: "cart", path: "carrito", label: "tabCart", Icon: TabBasketIcon },
  { key: "account", path: "cuenta", label: "tabAccount", Icon: TabPersonIcon },
] as const satisfies ReadonlyArray<{
  key: TabKey;
  /** The path under the locale prefix, which is also what `activeTab` reads. */
  path: string;
  /** A key under the `nav` namespace. */
  label: string;
  Icon: () => React.ReactElement;
}>;

export function TabBar({ locale }: { locale: string }) {
  const { count } = useCart();
  const t = useTranslations("nav");
  // next-intl strips the locale prefix, so this is `/catalogo`, not `/zh/catalogo`.
  const pathname = usePathname();
  const current = activeTab(pathname);

  if (current === "cart") return null;

  return (
    <nav
      aria-label={t("tabsLabel")}
      // The safe area is PADDING rather than a taller bar: the four rows stay
      // 56px of thumb, and the home indicator gets its strip of white under
      // them instead of stretching the targets over it.
      className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-surface pb-[env(safe-area-inset-bottom)] lg:hidden"
    >
      {/* Capped at the same 5xl the header and every page inset use, so on the
          widest phone (and on a narrow tablet, below `lg`) the four tabs stay
          under the content they navigate rather than spreading to the glass. */}
      <div className="mx-auto flex max-w-5xl">
        {TABS.map(({ key, path, label, Icon }) => {
          const active = current === key;
          const badge = key === "cart" && count > 0;
          return (
            <Link
              key={key}
              href={`/${locale}/${path}`}
              aria-current={active ? "page" : undefined}
              // The badge is decoration (`aria-hidden` below), so the count is
              // said in WORDS here instead — and only when there is one. With
              // an empty cart the visible label is already the whole name.
              aria-label={badge ? t("cartWithCount", { n: count }) : undefined}
              // The mockup paints the three inactive tabs in the design's
              // faintest grey, and this is one of the places the repo does not
              // follow it: `text-faint` is #A8A099, 2.58:1 on the white bar,
              // and these are 10.5px labels and 17px glyphs — AA wants 4.5:1 of
              // the words and 3:1 of the marks — on the ONLY navigation a phone
              // gets. `text-muted` (#6E6760, 5.57:1) is the same warm grey a
              // shade darker and clears both. Same call as Task 1's chips and
              // the /cuenta card: AA over mockup literalism. `faint` keeps the
              // uses `globals.css` licenses it for — placeholders and
              // supplementary counts, text that repeats what a label already
              // said — and the name of a screen is neither.
              className={`relative flex h-14 flex-1 flex-col items-center justify-center gap-1 text-[10.5px] ${
                active ? "font-semibold text-brand-ink" : "text-muted"
              }`}
            >
              <Icon />
              <span>{t(label)}</span>
              {badge && (
                // Up and to the RIGHT of the glyph, half off it — the design's
                // `top:8px; left:calc(50% + 6px)`, which is the only place a
                // badge can sit on a 17px icon without covering it. Hidden from
                // the accessibility tree: the link's own label says the number.
                <span
                  aria-hidden
                  className="absolute top-2 left-[calc(50%+6px)] flex h-4 min-w-4 items-center justify-center rounded-full bg-brand px-1 font-num text-[10px] font-bold text-white tabular-nums"
                >
                  {count}
                </span>
              )}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
