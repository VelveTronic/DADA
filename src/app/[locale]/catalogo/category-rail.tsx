import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { RailAutoscroll } from "./rail-autoscroll";

/**
 * One entry of the rail, already resolved by the page: the page owns what a
 * category MEANS in a URL (see `href()` in `page.tsx`), this file owns what one
 * looks like.
 */
export type RailEntry = {
  /** React key only — categories are keyed by their numeric DB id. */
  id: string | number;
  label: string;
  href: string;
  active: boolean;
  /** Only 常购 carries one: the number of products this restaurant has starred. */
  count?: number;
};

/**
 * The catalogue's left rail: 全部, 常购, then every active category, as a column
 * of links in an 88px gutter (a full 13rem from `lg` up, where there is room for
 * the longest Spanish category name on one line).
 *
 * **A rail, not the chip row it replaces.** The categories used to be a
 * horizontally scrolling strip of pills above the list, which on a phone showed
 * four of the sixty-one and hid the rest behind a sideways drag — the design
 * turns the axis: the whole list is one thumb-scroll away and the entry the page
 * is showing is lit while the products sit beside it. It also absorbed the old
 * 全部商品/我的收藏 tab pair, so the screen has ONE control that says what is in
 * the right-hand pane instead of two that had to be read together.
 *
 * Every entry is a plain `<Link>` and every press is a navigation: this is a
 * server-rendered list of server-filtered products, and the rail is its index.
 * The one client thing about it is `RailAutoscroll` below, which is about scroll
 * position and nothing else.
 *
 * `min-h-11` is the 44px touch target; entries grow past it when a name wraps,
 * and 常购 always does — its count is stacked under the word rather than beside
 * it, because at 88px wide there is no beside.
 */
export async function CategoryRail({ entries }: { entries: RailEntry[] }) {
  const t = await getTranslations("catalog");

  return (
    <nav
      aria-label={t("railLabel")}
      className="w-[88px] flex-none overflow-y-auto border-r border-border bg-surface-dim lg:w-52"
    >
      {entries.map((entry) => (
        <Link
          key={entry.id}
          href={entry.href}
          // 63 links in one scrolling column, and the default `auto` prefetch
          // would fire on every one of them as it enters the viewport. It would
          // fetch nothing worth having: `/catalogo` is `force-dynamic` and has
          // no `loading.tsx`, so a dynamic route's auto-prefetch stops at the
          // nearest loading boundary and there is none
          // (`node_modules/next/dist/docs/01-app/03-api-reference/02-components/link.md`).
          prefetch={false}
          // The lit entry is the page's current filter, which is what
          // `aria-current="page"` means; the data attribute is the handle
          // `RailAutoscroll` finds it by.
          aria-current={entry.active ? "page" : undefined}
          data-rail-active={entry.active ? "" : undefined}
          className={`relative flex min-h-11 items-center border-b border-[#E9E4DF] px-3 py-3 text-[12.5px] leading-tight ${
            entry.active
              ? "bg-surface font-bold text-brand-ink"
              : "text-ink-soft hover:text-ink"
          }`}
        >
          {/* The active entry is white against the rail's dim ground — the same
              white as the pane beside it, so the two read as one surface — and
              this is the red edge that marks it. Decorative: the colour, the
              weight and `aria-current` have all said it already. */}
          {entry.active && (
            <span
              aria-hidden
              className="absolute top-2.5 bottom-2.5 left-0 w-[3px] rounded-r bg-brand"
            />
          )}
          {/* The label is a SPAN and not a bare text node, and the pair of
              classes on it is what keeps a Spanish rail inside 88px. Five
              category names have a word longer than the 64px between the
              gutters — Electrodomésticos wants 121px — and a bare text node is
              an anonymous FLEX ITEM, whose automatic minimum is its min-content
              width: the entry could not shrink under it, `break-words` alone
              could not help (it does not change intrinsic sizing), and the
              overflow turned the rail's `overflow-y-auto` into a horizontal
              scroller as well — one visible axis beside a scrolling one
              computes to `auto` — so the whole column could be dragged sideways
              and the name was clipped anyway. `min-w-0` lets the item narrow to
              the gutters and `break-words` then wraps the word onto a second
              line. Chinese needs neither: it breaks between any two glyphs. */}
          <span className="min-w-0 break-words">
            {entry.label}
            {entry.count != null && (
              <span className="block font-num text-[11px] text-faint">
                {entry.count}
              </span>
            )}
          </span>
        </Link>
      ))}
      {/* The rail's own tail, and it needs one for the same reason the pane
          beside it does: 63 entries with NOTHING after them, in a column that
          scrolls to the glass. The tab bar covers its last entries always (top
          edge 57px + the safe area up from the glass) and the demand bar covers
          them too whenever the cart has something in it — that bar spans
          x = 14…376 on a 390px phone and this rail is x = 0…88, so it is over
          this column, not just the products. Same 7.5rem + `env()` as the pane
          tail: the two columns then reach their ends together instead of one
          stopping 120px short of the other. `lg` has neither bar. */}
      <div
        aria-hidden
        className="h-[calc(7.5rem+env(safe-area-inset-bottom))] lg:h-0"
      />
      <RailAutoscroll />
    </nav>
  );
}
