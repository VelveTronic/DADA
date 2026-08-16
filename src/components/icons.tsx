/**
 * The storefront header's glyphs, as inline SVG.
 *
 * No icon package: the repo ships none, and four outlines are not worth one.
 * Every icon is drawn on the same 24-unit grid with `stroke="currentColor"`, so
 * it takes the colour of whatever link or button holds it — which is the whole
 * mechanism behind the active-route accent (`text-brand-ink` on the anchor, and
 * the icon follows) and behind hover.
 *
 * `aria-hidden` on all four, without exception: every one of them sits inside a
 * control that carries its own `aria-label`, and a titled icon inside a labelled
 * button is announced twice.
 *
 * A plain module with NO imports, like `ui.ts` — both Server and Client
 * Components render these, and anything reaching `next/headers` would break the
 * client half of the header.
 */

const ICON_PROPS = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.7,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  className: "size-6",
  "aria-hidden": true,
} as const;

/** 商店 — the catalogue, drawn as a shop front with an awning. */
export function ShopIcon() {
  return (
    <svg {...ICON_PROPS}>
      <path d="M3.5 9.5 5 4.5h14l1.5 5" />
      <path d="M3.5 9.5a3 3 0 0 0 5.7 1 3 3 0 0 0 5.6 0 3 3 0 0 0 5.7-1" />
      <path d="M5 11.5V19a.5.5 0 0 0 .5.5h13a.5.5 0 0 0 .5-.5v-7.5" />
      <path d="M10 19.5v-5h4v5" />
    </svg>
  );
}

/** 搜索 — the loupe. */
export function SearchIcon() {
  return (
    <svg {...ICON_PROPS}>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4 4" />
    </svg>
  );
}

/** 购物车 — a basket, which is what a restaurant fills here. */
export function CartIcon() {
  return (
    <svg {...ICON_PROPS}>
      <path d="M3 8.5h18l-1.7 9a1.5 1.5 0 0 1-1.5 1.2H6.2a1.5 1.5 0 0 1-1.5-1.2Z" />
      <path d="M8.5 8.5 12 3.5l3.5 5" />
      <path d="M9.5 12.5v3M14.5 12.5v3" />
    </svg>
  );
}

/** 我的账号 — the head-and-shoulders every storefront uses for this menu. */
export function UserIcon() {
  return (
    <svg {...ICON_PROPS}>
      <circle cx="12" cy="8.5" r="3.5" />
      <path d="M4.5 20a7.5 7.5 0 0 1 15 0" />
    </svg>
  );
}
