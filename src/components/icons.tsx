/**
 * The portal's glyphs, as inline SVG: the storefront header's four, and the
 * staff sidebar's row of nav icons.
 *
 * No icon package: the repo ships none, and a dozen outlines are not worth one.
 * Every icon is drawn on the same 24-unit grid with `stroke="currentColor"`, so
 * it takes the colour of whatever link or button holds it — which is the whole
 * mechanism behind the active-route accent (`text-brand-ink` on the anchor, and
 * the icon follows) and behind hover.
 *
 * `aria-hidden` on all of them, without exception: every one sits inside a
 * control that carries its own name — an `aria-label` in the header, the
 * (sometimes visually hidden) label beside it in the sidebar — and a titled icon
 * inside a labelled button is announced twice.
 *
 * A plain module with NO imports, like `ui.ts` — both Server and Client
 * Components render these, and anything reaching `next/headers` would break the
 * client half of the header and the sidebar's drawer alike.
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

/** 需求单 — a basket, which is what a restaurant fills here. */
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

/* ── The staff sidebar ──────────────────────────────────────────────────────
   Six nav glyphs and the three controls around them. They are drawn on the
   same grid as the four above and take their colour the same way, which is what
   lets the sidebar's active row tint the icon by tinting the anchor. */

/** 首页 — the back office's own front door. */
export function HomeIcon() {
  return (
    <svg {...ICON_PROPS}>
      <path d="M4 10.5 12 4l8 6.5" />
      <path d="M6 9.5V19a.5.5 0 0 0 .5.5h11a.5.5 0 0 0 .5-.5V9.5" />
      <path d="M10 19.5V14h4v5.5" />
    </svg>
  );
}

/** 订单 — the confirmation queue, drawn as the clipboard it is worked from. */
export function ClipboardIcon() {
  return (
    <svg {...ICON_PROPS}>
      <path d="M9 4.5h6a1 1 0 0 1 1 1v1H8v-1a1 1 0 0 1 1-1Z" />
      <path d="M8 6H6.5A1.5 1.5 0 0 0 5 7.5v11A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5v-11A1.5 1.5 0 0 0 17.5 6H16" />
      <path d="M8.5 11h7M8.5 14.5h7M8.5 18h4" />
    </svg>
  );
}

/** 商品 — a case, which is the unit this wholesaler sells in. */
export function BoxIcon() {
  return (
    <svg {...ICON_PROPS}>
      <path d="M12 3.5 20 7.5v9L12 20.5 4 16.5v-9Z" />
      <path d="M4 7.5 12 11.5l8-4" />
      <path d="M12 11.5v9" />
    </svg>
  );
}

/** 分类 — the catalogue's shelves, drawn as the 2×2 grid of a category rail. */
export function GridIcon() {
  return (
    <svg {...ICON_PROPS}>
      <rect x="4.5" y="4.5" width="6.5" height="6.5" rx="1.5" />
      <rect x="13" y="4.5" width="6.5" height="6.5" rx="1.5" />
      <rect x="4.5" y="13" width="6.5" height="6.5" rx="1.5" />
      <rect x="13" y="13" width="6.5" height="6.5" rx="1.5" />
    </svg>
  );
}

/** 用户 — two of them, so it cannot be mistaken for the account glyph above. */
export function UsersIcon() {
  return (
    <svg {...ICON_PROPS}>
      <circle cx="9.5" cy="8.5" r="3.5" />
      <path d="M3 19.5a6.5 6.5 0 0 1 13 0" />
      <path d="M16 5.4a3.5 3.5 0 0 1 0 6.2" />
      <path d="M17.4 14.3a6.5 6.5 0 0 1 3.6 5.2" />
    </svg>
  );
}

/** 设置 — sliders rather than a cog: the page holds switches, and "Ajustes"
    is the Spanish for exactly this picture. */
export function SlidersIcon() {
  return (
    <svg {...ICON_PROPS}>
      <path d="M4 7.5h9M19 7.5h1" />
      <circle cx="16" cy="7.5" r="2.5" />
      <path d="M4 16.5h3M13 16.5h7" />
      <circle cx="10" cy="16.5" r="2.5" />
    </svg>
  );
}

/** The phone's hamburger, which opens the sidebar as a drawer. */
export function MenuIcon() {
  return (
    <svg {...ICON_PROPS}>
      <path d="M4 7h16M4 12h16M4 17h16" />
    </svg>
  );
}

/** …and the way out of it. */
export function CloseIcon() {
  return (
    <svg {...ICON_PROPS}>
      <path d="m6 6 12 12M18 6 6 18" />
    </svg>
  );
}

/** 退出登录 — a door with an arrow leaving through it. */
export function LogoutIcon() {
  return (
    <svg {...ICON_PROPS}>
      <path d="M9.5 4.5h-3A1.5 1.5 0 0 0 5 6v12a1.5 1.5 0 0 0 1.5 1.5h3" />
      <path d="M11 12h9" />
      <path d="m16.5 8.5 3.5 3.5-3.5 3.5" />
    </svg>
  );
}
