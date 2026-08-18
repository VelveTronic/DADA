# DADA Portal — Plan 13: Client Mobile Redesign (需求单模式, Claude Design) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the CUSTOMER side of the portal to the owner's approved Claude Design mockup — a mobile-first "需求单" (demand-list) ordering app: warm-beige ground, left category rail linked to the product list, steppers in every list, a bottom 4-tab bar (分类/搜索/需求单/我的), a floating black demand bar, a dedicated search page with history, an account hub, and order cards with status tabs and 再来一单.

**Architecture:** Pure UI/UX layer work on the existing server-first Next.js 16 App Router portal. No schema changes, no new RPCs; two new server actions (`clearCart`, `reorderIntoCart`) that only write the existing httpOnly cart cookie. Pages stay force-dynamic RSC with client leaves (CartProvider/steppers pattern unchanged). Two new routes (`/buscar`, `/cuenta`); staff area untouched except for inheriting the palette tokens.

**Tech Stack:** Next.js 16 (App Router, `src/proxy.ts` middleware — read `AGENTS.md` + `node_modules/next/dist/docs/` before framework-level code), React 19, Tailwind 4 (`@theme` tokens), next-intl 4 (zh default + es, key parity enforced by `src/i18n/messages.test.ts`), @supabase/ssr, vitest.

**Design source (the spec):** `docs/design/dada-mobile-client.dc.html` — 7 phone frames (390×844) exported from the owner's Claude Design project "供应商叫货平台设计". Read the markup + inline styles directly; they ARE the spec (colors, spacing, radii, font sizes). `docs/design/support.js` is only the mockup runtime — ignore it. Screens: 01 分类点货 (rail+list), 02 需求单已选, 03 需求单加货 (= our catalog, not a separate page), 04 搜索, 05 我的账号, 06 我的订单, 07 我的信息.

---

## Locked design decisions (deviations from the mockup are DELIBERATE — do not "fix" them)

1. **Mockup chrome is not product.** The 9:41 status bar, the 30px phone-frame radius, and the frame drop shadows are canvas presentation. Never implement them.
2. **Out of scope, by decision:** 切换 (store switcher — one company per login), 修改订单 (customer order editing — no RPC exists; staff edit lines instead), 联系客服 / 发票与对账 / 通知设置 rows, 常购排序 ⌄ sort control, order-card "DD-20260818-014" number format (we display the real `order_number`, e.g. Nº 1005). Do not build backends for these.
3. **The portal keeps features the mockup omits:** per-row product meta (`codart · CAJA×24`), 断货/称重 badges, prices when the owner's `show_prices` switch is ON (production has it OFF today, which is exactly the mockup's no-price look), the favorites star, pagination, zh/es i18n, weighed-line decimal quantities. Design rows show only name+stepper; ours show name, meta line, optional price, stepper, star.
4. **Fonts:** add **Archivo** via `next/font/google` (latin subset, weights 500/600/700) for numerals/order numbers/stats — exposed as `--font-archivo` → Tailwind `font-num`. Do NOT ship Noto Sans SC (CJK webfont weight is not worth it); body stack becomes `"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans SC", sans-serif`.
5. **Route names stay Spanish** (`/catalogo`, `/carrito`, `/pedidos`, `/perfil`, `/direcciones`) + new `/buscar`, `/cuenta`. `/carrito` is NOT renamed even though zh now calls it 需求单.
6. **需求单 vocabulary:** zh renames 购物车→需求单 everywhere a customer reads it (提交需求单, 去提交, 需求单是空的…). es uses "pedido" language (Mi pedido, Enviar pedido). When `show_prices` is off, checkout shows 无需付款 / "Sin pago en línea"; when on, subtotals render as today.
7. **Catalog search box is a link** to `/buscar` (design 01's box). `/catalogo` stops reading `?q` entirely — `/buscar` owns search. `?focus=search` behavior is deleted with it.
8. **Rail pseudo-entries:** the left rail is [全部, 常购 (favorites), …all active categories]. 全部 is the default (preserves `/catalogo` bare-URL behavior). Design's cart-screen "已选" rail is NOT built — the cart page is single-pane (design 03's "add more" mode is simply the catalog).
9. **TabBar hides on `/carrito`** (design 02 shows a submit bar instead of nav); the cart page gets a ‹ back link to `/catalogo` so mobile is never trapped.
10. **Floating demand bar** (black, design 01) shows only on `/catalogo` and `/buscar`, `lg:hidden`, count>0. It replaces the current red pill `CartBar` everywhere.
11. **Staff pages inherit the new tokens only** (ground, brand red, borders, solid cards). No staff layout work; a smoke check that nothing broke is part of Task 1 and Task 9.
12. **Customer order tabs are 4, not 6:** 全部 / 进行中 (submitted+confirmed+processing+bridge_failed+injected) / 已完成 (albaran) / 已取消 (cancelled). The per-order status chip stays precise (7 statuses). Customers should not learn our bridge states from tabs.
13. **再来一单 MERGES into the current cart** (never wipes it): lines already in the cart keep their quantity; missing lines are added while capacity (60) allows and the product is still orderable; the cart page banners how many were added/skipped.

## Background facts for implementers

- **Gate before every commit:** `pnpm bridge:build` → `pnpm lint` → `pnpm typecheck` → `pnpm test` → `pnpm build`, all zero. Commits end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. **Never push** — the controller pushes after review.
- Every new UI string needs **zh AND es** keys (`messages/zh.json`, `messages/es.json`); `src/i18n/messages.test.ts` enforces parity. zh is the default locale; write real business Spanish, not machine gloss.
- **A11y conventions (non-negotiable, from prior reviews):** every icon-only control has `aria-label`; interactive targets ≥44px (36px floor for secondary in-row controls like the star); badges never inside `truncate`; `aria-current="page"` on active nav; the stepper's keyed-`+`/focus-handoff behavior in `qty-stepper.tsx` must survive restyling (read its comments first).
- Customer data access rules (CLAUDE.md): products via `products_priced` view only, never `select('*')` on products/orders; orders via `PUBLIC_ORDER_COLUMNS`. `order_items` IS customer-readable (RLS company-scoped) — needed by Task 7.
- Test accounts for browser verification are in `docs/comandos.md` (§测试账号). **The DB is production and the ERP bridge is live: NEVER press 提交需求单 / create an order during verification.** Cart writes, favorites, search are fine; clear the test cart when done.
- Current UI class vocabulary lives in `src/components/ui.ts`; palette tokens in `src/app/globals.css` (Tailwind v4 `@theme` — each `--color-x` key auto-generates `bg-x`/`text-x`/`border-x` utilities).
- The repo has 800+ vitest tests; UI pages have no unit tests (RSC) — new PURE helpers (tab maps, history push, month-start) get table-driven tests next to the module.

## Token sheet (single source for every task; exact hex from the design doc)

| Token (`@theme`) | Value | Use |
|---|---|---|
| `--color-background` | `#F1EEEB` | page ground (warm beige) |
| `--color-surface` | `#FFFFFF` | cards, header, list panes (SOLID — glass/blur is retired) |
| `--color-surface-dim` | `#F7F5F3` | rail bg, grouped-page ground, info boxes, chips |
| `--color-border` | `#F2EEEA` | hairlines on white (row dividers, card borders) |
| `--color-border-strong` | `#E4DED8` | control borders (stepper −, quiet buttons, inputs use #E9E4DF via FIELD) |
| `--color-ink` | `#1C1917` | primary text; also the demand bar's black |
| `--color-ink-soft` | `#57504A` | secondary text, − glyphs, inactive rail entries |
| `--color-muted` | `#79726B` | tertiary text, hints |
| `--color-faint` | `#A8A099` | placeholders, inactive tab icons/labels, counts |
| `--color-brand` | `#E0231C` | fills: buttons, active bar, badge dot (white on it = 4.75:1 AA ✓) |
| `--color-brand-ink` | `#B31710` | red TEXT on light grounds (6.9:1) + hover state of brand fills |
| `--color-brand-soft` | `#FDECEA` | soft red fills: submitted chip, account icon boxes |
| `--radius-card` | `14px` | cards (was 16px) |
| `--font-num` | `var(--font-archivo), ui-sans-serif, sans-serif` | numerals, order numbers, stats, qty |

Non-token one-offs used at call sites (arbitrary values): notice bar `#FFF6F5` bg + `#FBE4E2` border; rail-item divider `#E9E4DF`; chevron `#C9C1BA`; field bg `#FBFAF9`; status-chip pairs (Task 1); stepper `+` shadow `0 2px 6px -1px rgba(224,35,28,.45)`; submit shadow `0 6px 16px -6px rgba(224,35,28,.6)`.

---

### Task 1: Tokens, Archivo, card/control vocabulary, status-chip palette

**Files:**
- Modify: `src/app/globals.css` (@theme rewrite per token sheet)
- Modify: `src/app/[locale]/layout.tsx` (Archivo via next/font)
- Modify: `src/components/ui.ts` (vocabulary rewrite; `GLASS_CARD` → `CARD`)
- Modify: every `GLASS_CARD` import site (mechanical rename; `grep -r GLASS_CARD src/`)
- Modify: `src/components/order-status-badge.tsx`
- Modify: `src/components/app-shell.tsx`, `src/components/staff-shell.tsx` (header/sidebar surfaces: drop `backdrop-blur`+translucency for solid `bg-surface`)

- [ ] **globals.css:** replace the @theme block with the token sheet above (keep the long "single light theme" comment, updating its wording: the look is now the warm-beige mockup, still deliberately light-only; keep `color-scheme: light`). Body font-family per decision 4. Delete nothing else.
- [ ] **layout.tsx:** `import { Archivo } from "next/font/google"; const archivo = Archivo({ subsets: ["latin"], weight: ["500", "600", "700"], variable: "--font-archivo", display: "swap" });` and add `archivo.variable` to the `<body>` className. (Next 16: check the existing html/body structure in this file and `node_modules/next/dist/docs/` if unsure where classNames land.)
- [ ] **ui.ts rewrite** (keep the module import-free; update the header comment):
  - `CARD = "rounded-[var(--radius-card)] border border-border bg-surface"` (renamed from GLASS_CARD, blur dropped — blur over opaque white is a no-op and the design is solid). Mechanically update every import/usage (customer + staff pages).
  - `FIELD = "rounded-[10px] border border-[#E9E4DF] bg-[#FBFAF9] px-3 py-2 text-ink placeholder:text-faint focus:border-brand focus:outline-none"`; `FIELD_SM` same at `px-2 py-1 text-sm`.
  - `BTN_PRIMARY = "rounded-[10px] bg-brand px-4 py-2 font-semibold text-white transition-colors hover:bg-brand-ink disabled:cursor-not-allowed disabled:opacity-40"`.
  - `BTN_QUIET` keeps shape but `border-border-strong bg-surface hover:border-brand hover:text-brand-ink`.
  - **Stepper vocabulary replaces the capsule** (design: two detached 32px squares, radius 8): `STEPPER_WRAP = "inline-flex items-center gap-0.5"`, `STEPPER_DEC = "inline-flex size-8 items-center justify-center rounded-lg border border-border-strong bg-surface text-[17px] leading-none text-ink-soft transition-colors hover:border-brand hover:text-brand-ink"`, `STEPPER_INC = "inline-flex size-8 items-center justify-center rounded-lg bg-brand text-[17px] leading-none text-white shadow-[0_2px_6px_-1px_rgba(224,35,28,.45)] transition-colors hover:bg-brand-ink disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-brand"`, `STEPPER_QTY = "min-w-6 max-w-8 truncate text-center font-num text-[15px] font-semibold tabular-nums"`. Delete old `STEPPER`/`STEPPER_BTN`.
  - Update `src/components/cart/qty-stepper.tsx` to the new classes — **same DOM shape** (one wrapper, keyed `minus`/`qty`/`plus`, `plusRef` focus handoff, aria-labels, aria-live). Width check: 32+2+32(max qty)+2+32 = 100px = the 6.25rem `STEPPER_SLOT` in `product-row.tsx` — unchanged, verify visually later.
  - `ICON_BTN`/`ICON_BTN_ACTIVE`/`NAV_LINK` stay (desktop header still uses them).
- [ ] **order-status-badge.tsx:** chip shape `inline-flex items-center rounded-md px-2 py-1 text-xs font-semibold`; per-status pairs — submitted `bg-brand-soft text-brand-ink`; confirmed `bg-[#FFF4E6] text-[#B26A00]`; processing keeps its current violet pair; bridge_failed keeps its current pair; injected `bg-[#EEF2F7] text-[#3E5A78]`; albaran `bg-[#F0F4F0] text-[#4A6A4E]`; cancelled `bg-gray-200 text-gray-600`. Labels/messages untouched.
- [ ] **Shells:** app-shell header + staff-shell topbar/sidebar swap `bg-background/85 backdrop-blur-[14px]` (and any `bg-surface backdrop-blur`) for solid `bg-surface`; borders stay `border-border`. **Read the staff-shell comment about backdrop-filter/fixed-descendant containing blocks before touching it** — removing the blur must not regress the drawer, but do not restructure.
- [ ] Gate (all five, zero). **Browser smoke** (`pnpm preview`, login both test accounts): catalog + cart + staff home/productos render coherently on the new palette — warm ground, solid white cards, red = E0231C family; screenshot each. No layout work yet.
- [ ] Commit `feat(ui): warm-beige token sheet, Archivo numerals, solid cards, design status chips`.

### Task 2: Catalog rebuild — 分类点货 two-pane (design 01)

**Files:**
- Modify: `src/app/[locale]/catalogo/page.tsx` (layout + drop `?q`)
- Create: `src/app/[locale]/catalogo/category-rail.tsx` (server) + `src/app/[locale]/catalogo/rail-autoscroll.tsx` (client leaf)
- Move+modify: `src/app/[locale]/catalogo/product-row.tsx` → `src/components/product-row.tsx` (restyle; `/buscar` reuses it in Task 3)
- Modify: `src/components/app-shell.tsx` (add `layout?: "page" | "viewport"` prop)
- Modify: `src/components/product-thumb.tsx` (48px → 44px, `rounded-lg`)
- Modify: `messages/zh.json`, `messages/es.json`

- [ ] **AppShell `layout` prop:** default `"page"` renders exactly as today. `"viewport"` wraps header+main in `<div className="flex h-dvh flex-col">`, header `flex-none`, and `<main className="mx-auto flex w-full max-w-5xl min-h-0 flex-1 flex-col">` (no `px-4 pb-16` — the page owns its insets; `CartErrorBanner` stays first child of main, give it `px-4` in viewport mode). Only `/catalogo` uses it.
- [ ] **Page top zone** (`flex-none`): ① search LINK styled as the design's box — `<Link href={`/${locale}/buscar`} aria-label={t("searchPlaceholder")}>` rendering `h-10 mx-4 mt-2 rounded-[10px] bg-surface-dim flex items-center gap-2 px-3 text-sm text-faint` with `SearchIcon` (size it small) + placeholder text 搜索商品 / 品牌 / 规格; ② notice bar — `flex items-center gap-2 bg-[#FFF6F5] border-y border-[#FBE4E2] px-4 py-2 mt-3 text-xs text-brand-ink` with a `size-[5px] rounded-full bg-brand flex-none` dot; copy = new key `catalog.notice` zh 提交需求单后由 DADA 客服确认排单，无需在线付款 / es "Tras enviar el pedido, DADA lo confirma y organiza el reparto; sin pago en línea." **Delete the old `<form method="get">`, the `?q`/`focus` searchParams handling, `sanitizeSearch` import, and the tabs `<nav>`** (tabs are replaced by the rail's 常购 entry).
- [ ] **Two panes** (`flex flex-1 min-h-0`):
  - `category-rail.tsx` (server): `<nav aria-label={t("railLabel")} className="w-[88px] lg:w-52 flex-none overflow-y-auto bg-surface-dim border-r border-border">`. Entries = 全部 (`href({cat:"",tab:"all"})`), 常购 (`tab=favoritos`), then every active category. Entry: `relative flex min-h-11 items-center border-b border-[#E9E4DF] px-3 py-3 text-[12.5px] leading-tight` — active adds `bg-surface font-bold text-brand-ink` + `<span aria-hidden className="absolute left-0 top-2.5 bottom-2.5 w-[3px] rounded-r bg-brand">` + `data-rail-active` + `aria-current="page"`; inactive `text-ink-soft hover:text-ink`. Favorites entry shows count: `常购 <span className="font-num text-[11px] text-faint">{n}</span>` (stacked, `leading-tight`).
  - `rail-autoscroll.tsx` (client, rendered inside the nav): `useEffect` once → `document.querySelector('[data-rail-active]')?.scrollIntoView({ block: "nearest" })` — a full navigation resets rail scroll and category #40's active entry must stay visible. No deps beyond React.
  - Right pane: `<div className="min-w-0 flex-1 overflow-y-auto">` — sticky pane header `sticky top-0 z-10 flex items-baseline justify-between bg-surface px-4 py-3` with active label (全部/常购清单/category) `text-sm font-bold` + `共 {count} 种` `text-xs text-faint font-num tabular-nums` (count = the existing exact count); then the row `<ul>` (rows get `border-t border-[#F4F0EC]`, list loses the CARD wrapper — the pane IS white); empty state + pager stay INSIDE this pane (keep current markup, restyled buttons); final `<div className="h-28 lg:h-8" aria-hidden>` spacer for the floating bars.
- [ ] **Query changes:** drop `q` from the query builder + `href()`; keep favorites tab filter, category filter, pagination, the two-round `Promise.all` shape, `cartPrices`, `showPrices`, perf steps. `tab=favoritos` renders with rail 常购 active and pane header 常购清单.
- [ ] **product-row.tsx** (moved to `src/components/`): keep the documented grid + fixed action column + star exactly; restyle only — name `text-sm font-semibold leading-[1.35]`, price line `font-num`, row `py-2.5`; thumb via product-thumb 44px `rounded-lg`. Update imports (`catalogo/page.tsx`; Task 3 will import it too).
- [ ] i18n: add `catalog.notice`, `catalog.railLabel` (分类 / Categorías), `catalog.railAll` (全部 / Todo), `catalog.railFavorites` (常购 / Habituales), `catalog.paneFavorites` (常购清单 / Mis habituales); remove dead keys only if nothing references them (`searchButton` dies with the form; check `grep -r "searchButton"` — es+zh both).
- [ ] Gate. Browser-verify at 390×844 AND ≥1024: rail scrolls independently, active entry auto-scrolled into view, category switch keeps rail position sane, favorites entry works, long zh/es names clamp at 2 lines without touching the stepper, pager works inside the pane, old red CartBar still floats (it is replaced in Task 5 — fine). Screenshots.
- [ ] Commit `feat(catalog): two-pane category rail per design 01`.

### Task 3: Search page — /buscar (design 04)

**Files:**
- Create: `src/app/[locale]/buscar/page.tsx`
- Create: `src/app/[locale]/buscar/search-history.tsx` (client)
- Create: `src/lib/search-history.ts` + `src/lib/search-history.test.ts`
- Modify: `messages/zh.json`, `messages/es.json`

- [ ] **`src/lib/search-history.ts`** (pure, no I/O):
  ```ts
  export const SEARCH_HISTORY_KEY = "dada.search.history";
  export const SEARCH_HISTORY_MAX = 10;
  /** Raw localStorage value → clean list (JSON string[] only; junk → []). */
  export function parseHistory(raw: string | null): string[]
  /** Move-to-front, trimmed, deduped (exact match), capped at MAX. Empty/whitespace q → unchanged list. */
  export function pushHistory(list: string[], q: string): string[]
  ```
  Table-driven tests: junk JSON → `[]`, non-array → `[]`, non-string entries dropped, dedupe moves to front, cap at 10, whitespace-only q is a no-op, q is trimmed.
- [ ] **page.tsx** (force-dynamic, `beginCompanyUser`/`finishCompanyUser`, perf steps, AppShell `layout="page"`): reads `?q` (sanitize via existing `sanitizeSearch`) + `?page`. Header row (in-flow, below shell header): GET form `action={`/${locale}/buscar`}` — real input `name="q"` `defaultValue={q}` `autoFocus` `aria-label` placeholder 搜索商品, styled `h-10 flex-1 rounded-[10px] border-[1.5px] border-brand bg-surface px-3 text-sm focus:outline-none`; a clear × as `<Link href={`/${locale}/buscar`}>` (44px target, `aria-label={t("clear")}`) shown only when q; 取消 `<Link href={`/${locale}/catalogo`}>` `text-sm text-ink-soft` (44px). Enter submits the form (GET → same page).
- [ ] **Results** (q non-empty): same query shape as the old catalog search — `products_priced`, `.eq("is_current_variant", true)`, `.or("codart.ilike.%q%,name->>zh.ilike.%q%,name->>es.ilike.%q%")`, count exact, PAGE_SIZE 50 + pager (reuse catalog's pager markup with `/buscar` hrefs). Favorites read as on catalog (star state). Section head: 搜索结果 `<span className="font-num">{count}</span>` 个商品. Rows: the shared `ProductRow`. Empty → existing-style empty state (no clear-filters link, the × is the way out). `cartPrices` map + `showPrices` exactly as catalog.
- [ ] **search-history.tsx** (client leaf, rendered above results / alone when no q): props `{ locale, q }`. State starts `[]`; on mount read+`parseHistory(localStorage.getItem(KEY))`; when `q` non-empty, `pushHistory` + write back + set state (one effect keyed on `q`). Render null while empty. UI: row 历史搜索 (`text-[12.5px] font-semibold text-ink-soft`) + 清除 button (`aria-label`, clears storage+state, 44px target) — then chip wrap: each history term a `<Link href={`/${locale}/buscar?q=${encodeURIComponent(term)}`} className="flex h-8 items-center rounded-full bg-surface-dim px-3 text-[12.5px] text-ink-soft">`. SSR renders nothing → no hydration mismatch.
- [ ] i18n `search.*`: title, placeholder, cancel, clear (清除/Borrar), history (历史搜索/Búsquedas recientes), results (搜索结果/Resultados), resultCount (`{n} 个商品`/`{n} productos`), empty. zh+es.
- [ ] Gate. Browser-verify: type→enter→results with steppers, history chips accumulate/dedupe/clear, × clears, 取消 returns, works in es, mobile+desktop. Screenshots.
- [ ] Commit `feat(search): dedicated /buscar page with local history per design 04`.

### Task 4: Account hub — /cuenta (design 05)

**Files:**
- Create: `src/app/[locale]/cuenta/page.tsx`
- Modify: `src/lib/orders.ts` (+`src/lib/orders.test.ts`): `madridMonthStartIso`, `ACTIVE_ORDER_STATUSES`
- Modify: `src/components/user-menu.tsx` (add 我的账号 entry at top)
- Modify: `messages/zh.json`, `messages/es.json`

- [ ] **orders.ts:** `export const ACTIVE_ORDER_STATUSES: readonly OrderStatus[] = ["submitted", "confirmed", "processing", "bridge_failed", "injected"];` and
  ```ts
  /** UTC instant of Madrid's current month start, for created_at >= filters. */
  export function madridMonthStartIso(now: Date): string {
    const month = madridDay(now).slice(0, 7);            // "2026-08"
    const probe = new Date(`${month}-01T12:00:00Z`);     // DST never flips on the 1st
    const offset = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Madrid", timeZoneName: "longOffset" })
      .formatToParts(probe).find((p) => p.type === "timeZoneName")?.value.replace("GMT", "") || "+00:00";
    return `${month}-01T00:00:00${offset}`;
  }
  ```
  Tests: August date → `…+02:00`, January date → `…+01:00`, month rollover respects Madrid not UTC (e.g. `2026-08-31T22:30:00Z` = Madrid Sept 1 → `2026-09-01T00:00:00+02:00`).
- [ ] **page.tsx** (force-dynamic, guards, AppShell `layout="page"`): after the profile resolves, `Promise.all` FOUR cheap reads — `orders` count-only (`{ count: "exact", head: true }`) ① `.in("status", ACTIVE_ORDER_STATUSES)`, ② `.eq("status", "albaran")`, ③ `.gte("created_at", madridMonthStartIso(new Date()))`, each `.eq("company_id", …)`; ④ `favorites` count for the menu hint. Log errors, render 0 on null.
- [ ] **Header card** (in-flow CARD, `bg-brand text-white p-5`, no border): row — white 54px circle holding the logo `<Image src="/brand/dada-logo.png" … className="h-8 w-8">`, then `flex-col`: company name `text-lg font-bold`, `display_name · email` `text-xs opacity-80 truncate` (email from `getSessionUser` — see how `/perfil` reads it); right 编辑 `<Link href={`/${locale}/perfil`}>` `text-xs opacity-85` (44px, aria-label). Below: stats strip `flex rounded-xl bg-white/15 p-3` — three `flex-1 flex-col items-center gap-1`: `font-num text-xl font-bold tabular-nums` number + `text-[11px] opacity-85` label — 进行中 ①, 已完成 ②, 本月下单 ③.
- [ ] **Menu card** (CARD `divide-y divide-border`, rows `flex min-h-[54px] items-center gap-3 px-4 text-sm`): icon box `flex size-7 items-center justify-center rounded-lg bg-brand-soft` (simple inline SVGs, `stroke="currentColor"` `text-brand-ink`), label `flex-1`, hint `text-xs text-faint`, chevron `text-[#C9C1BA]`. Rows: 我的订单 → `/pedidos` (hint `{active} 个进行中` when >0); 常购清单 → `/catalogo?tab=favoritos` (hint `{n} 种`); 收货门店与地址 → `/direcciones`; 我的信息 → `/perfil`. Whole row is the Link.
- [ ] **Logout:** full-width CARD button `h-12 text-muted` posting the existing `signOut` server action (`src/app/actions/auth.ts` — mirror user-menu's form).
- [ ] **user-menu.tsx:** prepend 我的账号 → `/cuenta` (key `nav.account` already exists — repoint/verify wording 我的账号/Mi cuenta).
- [ ] i18n `account.*`: title 我的/Mi cuenta, edit, statActive 进行中/En curso, statDone 已完成/Completados, statMonth 本月下单/Pedidos este mes, menuOrders 我的订单, menuFavorites 常购清单, menuAddresses 收货门店与地址, menuProfile 我的信息, hintActive `{n} 个进行中`, hintKinds `{n} 种`, logout (reuse `common.logout`).
- [ ] Gate. Browser-verify: real counts for cliente-test, all four links land, logout works (log back in), es page. Screenshots.
- [ ] Commit `feat(account): /cuenta hub with stats and menu per design 05`.

### Task 5: Shell swap — bottom TabBar, demand bar, header split

**Files:**
- Create: `src/components/tab-bar.tsx` (client)
- Rewrite: `src/components/cart/cart-bar.tsx` (red pill → black demand bar)
- Modify: `src/components/app-shell.tsx`, `src/components/storefront-nav.tsx`
- Modify: `src/components/cart/cart-provider.tsx` + `src/lib/cart.ts` (+test) for the units sum
- Modify: `messages/zh.json`, `messages/es.json`

- [ ] **cart.ts:** `export function cartUnits(cart: Cart): number` — sum of quantities rounded to 3 decimals (weighed lines are fractional). Tests: empty→0, ints, `0.5+0.25`→0.75, float-noise rounding. **cart-provider.tsx:** expose `units: number` (from `cartUnits(optimisticCart)`) in the context value.
- [ ] **tab-bar.tsx** (client): `usePathname` (locale-stripped) + `useCart().count` + `useTranslations("nav")`. Hidden when `pathname === "/carrito"`. Structure: `<nav aria-label={t("tabsLabel")} className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-surface pb-[env(safe-area-inset-bottom)] lg:hidden"><div className="mx-auto flex max-w-5xl">` — four `<Link>`s `flex h-14 flex-1 flex-col items-center justify-center gap-1 text-[10.5px]`: 分类→`/catalogo`, 搜索→`/buscar`, 需求单→`/carrito`, 我的→`/cuenta` (`/cuenta` also active on `/pedidos`, `/perfil`, `/direcciones`). Active `text-brand-ink font-semibold` + `aria-current="page"`; inactive `text-faint`. Icons: 17px inline SVGs per the design's geometry (2×2 grid; loupe; clipboard; person arc), `stroke="currentColor"` or currentColor fills, `aria-hidden`. Cart badge: `<span className="absolute … min-w-4 h-4 rounded-full bg-brand px-1 font-num text-[10px] font-bold text-white tabular-nums">{count}</span>` on the 需求单 item (`relative`), hidden at 0; the visible label already names the tab, badge is `aria-hidden` with count folded into the link's `aria-label` (`需求单，{count} 种`).
- [ ] **cart-bar.tsx rewrite** (the DEMAND BAR, design 01's black strip): render only when `count > 0` AND pathname is `/catalogo` or `/buscar`; `lg:hidden fixed inset-x-3.5 bottom-[calc(3.5rem+env(safe-area-inset-bottom)+0.5rem)] z-40 flex h-[50px] items-center justify-between rounded-xl bg-ink pl-4 pr-1.5 shadow-[0_10px_24px_-8px_rgba(28,25,23,.5)]`. Left `text-xs text-white`: 需求单 `<b className="font-num text-[15px] font-semibold">{count}</b>` 种 · `{units}` 件, and when `showPrices && subtotalCents != null` append ` · {formatEuros}`. Right: `<Link href={`/${locale}/carrito`} className="flex h-[38px] items-center rounded-[9px] bg-brand px-4 text-[13.5px] font-semibold text-white">` 去提交. Keep the scroll-room spacer idea from the old file where pages need it (catalog pane already has its h-28 spacer; `/buscar` gets `pb-36 lg:pb-16` on its content). Delete every old red-pill remnant.
- [ ] **app-shell.tsx:** header — left brand link as today; right: company name `hidden max-[calc(theme…)]:` — concretely: `<span className="ml-auto max-w-[45%] truncate text-xs text-muted lg:hidden">{user.name}</span>` on mobile, and `StorefrontNav` wrapped `hidden lg:flex` (move the `ml-auto` accordingly). Mount `<TabBar locale={locale} />` inside CartProvider (after main) and keep `<CartBar …>` mount. `page` layout main padding becomes `pb-[calc(4.5rem+env(safe-area-inset-bottom))] lg:pb-16` so the TabBar never covers content.
- [ ] i18n `nav.*`: tabsLabel (页面导航/Navegación), tabCatalog 分类/Catálogo, tabSearch 搜索/Buscar, tabCart 需求单/Pedido, tabAccount 我的/Mi cuenta, cartWithCount `需求单，{n} 种`/`Pedido, {n} líneas`; `cart.goSubmit` 去提交/Enviar, `cart.barSummary` `{lines} 种 · {units} 件`/`{lines} art. · {units} uds.` (compose in the component from parts if simpler — but keep translatable, no hardcoded zh).
- [ ] Gate. Browser-verify 390×844: tab bar on all 4 tabs with correct active states (+ badge count live on stepper press), demand bar floats above it on catalog/search only, disappears on `/carrito`, desktop ≥1024 unchanged header-icon nav and NO tab bar; safe-area padding visible in the phone emulation. Screenshots.
- [ ] Commit `feat(shell): bottom tab bar and black demand bar per design 01/04`.

### Task 6: 需求单 page — /carrito redesign (design 02)

**Files:**
- Modify: `src/app/[locale]/carrito/page.tsx`
- Modify: `src/components/cart/cart-line.tsx` (restyle only; keep client mechanics)
- Modify: `src/app/actions/cart.ts` (add `clearCart`)
- Create: `src/components/cart/clear-cart-button.tsx` (client)
- Modify: `messages/zh.json`, `messages/es.json`

- [ ] **`clearCart` server action** (in `actions/cart.ts`, mirroring `setCartLineQty`'s guard/cookie/revalidate idiom exactly): writes an EMPTY cart cookie, revalidates the same paths the existing action does, returns `{ ok: true }`. No inputs to validate beyond the locale it doesn't even need — keep the signature minimal and identical in style to its sibling.
- [ ] **clear-cart-button.tsx** (client): two-press arming — first press sets `armed` (label 清空 → 确认清空？, `text-brand-ink`), `onBlur`/4s timer disarms, second press `startTransition(() => clearCart())`. `aria-label` both states; ≥44px target; renders nothing when cart empty (`useCart().count === 0`).
- [ ] **page.tsx restructure** (keep: guards, one-round `Promise.all`, cookie read, row building, blocked logic, error banner params, hidden `client_token`, delivery-date window, `showPrices`/`showDeliveryDate` gates):
  - Title row: ‹ back `<Link href={`/${locale}/catalogo`} aria-label={t("backToCatalog")}>` (44px) + 我的需求单 `text-lg font-bold` + right `<ClearCartButton />`.
  - Lines CARD: rows restyled to the catalog grid (`grid-cols-[3rem_minmax(0,1fr)_auto] items-center gap-x-3 py-2.5`): thumb 44px; middle = name (`text-sm font-semibold line-clamp-2 break-words`) + meta line (codart · unit + weighed/unavailable badges, exactly today's content) + when `showPrices` the line total `font-num text-sm font-semibold` (sr-only label kept); right = **`QtyStepper` for non-weighed orderable lines, today's `CartQtyInput` for weighed lines** (decimal step stays), remove button as today. `CartLine`'s leave-on-zero client behavior untouched.
  - Under the card: 继续加货 `<Link href={`/${locale}/catalogo`} className="mt-3 flex h-11 items-center justify-center gap-1 rounded-card border border-dashed border-border-strong text-sm font-semibold text-brand-ink">+ 继续加货</Link>`.
  - Note block: label 订单备注 `text-[12.5px] font-semibold text-ink-soft` + textarea (FIELD, `h-[72px] resize-none`, placeholder = new `cart.notePlaceholder` wording 如：明早 7 点前送到后厨 / es equivalent, maxLength 2000). Delivery date (when enabled) keeps today's input above the note inside the same form.
  - Info box (`rounded-[10px] bg-surface-dim p-3.5 flex flex-col gap-2 text-xs`): rows `flex justify-between` label `text-muted` / value `text-ink` — 提交方式: 提交后由 DADA 排单配送 (`cart.methodValue`); 收货门店: `portalUser.companies.name`.
  - **Fixed submit bar** replaces the in-flow button (TabBar hides here — Task 5): form gets `id="checkout-form"`; bar `fixed inset-x-0 bottom-0 z-40 border-t border-border bg-surface px-4 pt-3 pb-[max(0.875rem,env(safe-area-inset-bottom))]` → inner `mx-auto flex max-w-5xl items-center justify-between gap-3`: left col — `<b className="font-num text-lg font-bold tabular-nums">{rows.length}</b> 种商品` + sub `text-[11px] text-faint`: 合计 `{units}` 件 followed by `· <CartSubtotal/>` when showPrices else `· 无需付款`; right `<button form="checkout-form" type="submit" disabled={!priceable} title={blockedMessage ?? undefined} className="h-12 flex-1 max-w-[196px] rounded-[11px] bg-brand text-[15px] font-semibold text-white shadow-[0_6px_16px_-6px_rgba(224,35,28,.6)] transition-colors hover:bg-brand-ink disabled:cursor-not-allowed disabled:opacity-40">提交需求单</button>`. Content above gets `pb-28` so the bar covers nothing. (`units` here = server-side sum over `cart` values, small inline `reduce` — the authoritative cookie, not the optimistic mirror; fine for a full-page form anyway.)
  - Empty state: CARD center `p-10` — 需求单是空的 + `BTN_PRIMARY` Link 去点货 → `/catalogo`. No fixed bar when empty.
- [ ] i18n `cart.*`: title→我的需求单/Mi pedido, clear 清空/Vaciar, clearConfirm 确认清空？/¿Vaciar todo?, backToCatalog 返回分类/Volver al catálogo, keepAdding 继续加货/Seguir añadiendo, methodLabel 提交方式/Modalidad, methodValue, storeLabel 收货门店/Entrega en, kindsCount `{n} 种商品`/`{n} artículos`, unitsTotal `合计 {n} 件`/`Total {n} uds.`, noPayment 无需付款/Sin pago en línea, submitOrder→提交需求单/Enviar pedido, notePlaceholder new wording. Rename zh 购物车 wording anywhere left (`grep -rn "购物车" messages/ src/`).
- [ ] Gate. Browser-verify: stepper +/− on normal line, decimal edit on a weighed line, clear-cart two-press (then re-add), 继续加货 round trip, submit bar disabled state with an unavailable line (toggle one OFF as staff in another tab, refresh, then back ON), fixed bar clear of content, **DO NOT submit the order**. zh+es, mobile+desktop. Screenshots.
- [ ] Commit `feat(cart): 需求单 single-pane redesign with fixed submit bar per design 02`.

### Task 7: Orders — /pedidos cards + tabs + 再来一单 (design 06)

**Files:**
- Modify: `src/app/[locale]/pedidos/page.tsx`
- Modify: `src/lib/orders.ts` (+test): customer tab map
- Modify: `src/app/actions/cart.ts` (add `reorderIntoCart`)
- Modify: `messages/zh.json`, `messages/es.json`

- [ ] **orders.ts:**
  ```ts
  export const CUSTOMER_ORDER_TABS = ["all", "active", "done", "cancelled"] as const;
  export type CustomerOrderTab = (typeof CUSTOMER_ORDER_TABS)[number];
  export function isCustomerOrderTab(v: string): v is CustomerOrderTab
  /** null = no filter. */
  export function statusesForTab(tab: CustomerOrderTab): readonly OrderStatus[] | null
  ```
  (`active` → `ACTIVE_ORDER_STATUSES` from Task 4, `done` → `["albaran"]`, `cancelled` → `["cancelled"]`.) Table-driven tests incl. junk `?tab=` → `all`.
- [ ] **Page:** reads `?tab` (validated) + keeps `?created` banner. Header row: ‹ back → `/cuenta` (44px, aria-label) + 我的订单. Tab chips `flex gap-2 overflow-x-auto py-1 -mx-4 px-4` — each `<Link>` `flex h-8 flex-none items-center whitespace-nowrap rounded-full px-3.5 text-[12.5px]`: active `bg-brand font-semibold text-white`, inactive `bg-surface-dim text-ink-soft`; `aria-current`. Query adds `.in("status", statuses)` when non-null.
- [ ] **Card data:** after orders resolve, TWO batched reads — ① `order_items` `.select("order_id, product_id, name, qty, unit, units_per_case, is_weighed, unit_price_cents, line_total_cents, codart").in("order_id", orderIds)`; ② `products_priced` `.select("id, image_url").in("id", distinct productIds)` for thumbnails. Group in memory. (Empty orders page skips both.)
- [ ] **Card** (CARD `p-3.5 flex flex-col gap-3` per order): row1 — `<span className="font-num text-xs text-muted">Nº {order_number}</span>` + `OrderStatusBadge` right. Row2 — up to 3 thumbs (`ProductThumb`, 50px via className override or its size prop — check the component) + col: `共 {lines} 种 · 合计 {units} 件` `text-[13px] font-semibold` (units = qty sum rounded 3dp) + `text-xs text-faint` line: placedAt + delivery date when set + `numped`/`numalb` chips as today's wording. Note (when `customer_note`): `rounded-lg bg-surface-dim p-2.5 text-xs leading-relaxed text-muted` 备注：….
  Lines detail: `<details className="group"><summary className="flex h-9 w-fit cursor-pointer list-none items-center rounded-lg border border-border-strong px-3.5 text-xs font-semibold text-ink-soft">查看详情</summary>` → content `mt-2 divide-y divide-border text-xs`: per line `flex justify-between gap-2 py-1.5` — name (localized from the jsonb snapshot via `localizedName`) truncating, `{qty} {unit}` `font-num tabular-nums`, and when `showPrices` the `line_total_cents` euro right-aligned; when `showPrices` a final subtotal row (`order.subtotal_cents`, `font-semibold`).
  Actions row `flex justify-end gap-2`: the `<details>` summary sits left of a 再来一单 form button — `<form action={reorderIntoCart}>` with hidden `order_id` + `locale`; button `flex h-9 items-center rounded-lg border border-brand px-3.5 text-xs font-semibold text-brand-ink transition-colors hover:bg-brand-soft` (aria-label includes the order number). Layout note: render `<details>` and the form as siblings in one row; the details content expands full-width BELOW the row (`details` wrapper spans the card width — structure: actions row contains summary-less pattern is invalid HTML, so: put `<details>` as the row's first flex child with `w-full`-expanding content via `[&[open]]:…` — simplest valid shape: `<div className="flex items-start justify-between gap-2">` where details is `flex-1` and its content just flows under its own summary; verify keyboard toggling).
- [ ] **`reorderIntoCart` action** (`actions/cart.ts`): validate `order_id` uuid + locale (existing idioms); guard as sibling actions do; ① confirm the order belongs — `orders.select("id").eq("id", orderId).eq("company_id", user.company_id).maybeSingle()`, bail silently to `/pedidos` on miss; ② read its `order_items (product_id, qty)`; ③ `products_priced.select("id, is_orderable").in("id", ids)`; ④ MERGE into the current cookie cart: for each item, skip if `product_id` already in cart (keep the customer's qty) or not orderable; else `try { cart = setQty(cart, id, qty) } catch { skipped++ }` (CART_FULL lands in skipped); count `added`/`skipped` (unorderable ones count as skipped too); ⑤ write cookie, redirect `/${locale}/carrito?readded=${added}&skipped=${skipped}`.
- [ ] **carrito banner:** page reads `?readded`/`?skipped` (parse as non-negative ints, else ignore): green `role="status"` banner `cart.reorderDone` — zh `已加入 {added} 种{skipped, plural, =0 {} other {，{skipped} 种无法加入（已下架或需求单已满）}}` — if ICU plural is awkward in this next-intl setup, use two keys and conditional render (`reorderAdded` + `reorderSkipped`). es equivalents.
- [ ] i18n `orders.*`: back, tabAll 全部/Todas, tabActive 进行中/En curso, tabDone 已完成/Completados, tabCancelled 已取消/Canceladas, kindsUnits `共 {lines} 种 · 合计 {units} 件`/es, detail 查看详情/Ver detalle, reorder 再来一单/Repetir pedido, reorderFor (aria), note 备注/Nota; `cart.reorderDone`(+split keys).
- [ ] Gate (new orders.test cases green). Browser-verify with cliente-test's real history (orders 1005-1009 exist): tabs filter correctly, details expand with real line names/qty (+euros when show_prices on — flip the owner switch as staff to see both modes, restore it after), thumbnails render, 再来一单 merges into a non-empty cart and banners counts, cart restored/cleared after. **No order submission.** Screenshots zh+es.
- [ ] Commit `feat(orders): status tabs, order cards with detail and reorder per design 06`.

### Task 8: Profile, addresses, login polish (design 07) + es sweep

**Files:**
- Modify: `src/app/[locale]/perfil/page.tsx` (+ its `profile-forms.tsx` classNames only)
- Modify: `src/app/[locale]/direcciones/page.tsx`
- Modify: `src/app/[locale]/login/page.tsx` (+`login-form.tsx` classNames only)
- Modify: `messages/zh.json`, `messages/es.json`

- [ ] **perfil:** top identity CARD `p-4 flex items-center gap-3.5` — 56px circle `bg-brand` holding the white logo Image, col: company name `text-[15px] font-bold` + `text-[11.5px] text-muted` 客户编号 {codcli} (query `companies.codcli` alongside the page's existing reads — check what `/direcciones` already selects and reuse the idiom; omit the line if null). Below, the two existing forms (display name / password) each in a CARD with a design-07-style section head `px-4 pt-3 pb-1 text-xs font-semibold text-faint` (账号资料 / 修改密码). Functionality, actions, hints untouched.
- [ ] **direcciones:** design 07's k/v card — CARD with section head 门店资料, rows `flex min-h-[52px] items-center gap-3 border-t border-border px-4 py-3 text-sm`: label `w-[76px] flex-none text-[13px] text-muted` / value `flex-1 text-right leading-snug` — 门店名称=company name, 联系人=display_name, 电话=address_phone, 地址=address+city+postal (compose non-null parts). The existing 地址有误请联系我们修改 note becomes the wash card: `rounded-card border border-[#FBE4E2] bg-[#FFF6F5] p-4` — head `text-[13px] font-semibold text-brand-ink` 修改资料 + body `text-[12.5px] text-ink-soft leading-relaxed` (existing copy). Keep empty states.
- [ ] **login:** ground/tokens flow from Task 1 already — align details: card = CARD `p-6`, logo 64px centered, fields FIELD `h-11`, submit `BTN_PRIMARY h-12 w-full text-[15px]`. No behavior change.
- [ ] **es sweep:** re-read EVERY key added by Tasks 2-7 in `messages/es.json` as a native reader (需求单 language: "pedido"; 常购 "habituales"; 件 "uds."); fix awkward wording; `grep -rn "购物车" src/ messages/` returns nothing customer-facing; parity test green.
- [ ] Gate. Browser-verify all three pages zh+es, mobile+desktop; password form still round-trips (use the test account, set the SAME password back). Screenshots.
- [ ] Commit `feat(account): profile/address/login styled to design 07`.

### Task 9: Full verification pass

**Files:** none (report + screenshots; fixes go in targeted commits if found)

- [ ] Full gate from clean: `pnpm bridge:build && pnpm lint && pnpm typecheck && pnpm test && pnpm build` — record counts.
- [ ] `pnpm preview` (webpack build + start, port 3000; the workspace `.claude/launch.json` "DADA" entry attaches). As **cliente-test** walk the seven design screens at 390×844: 01 catalog (rail linkage, stepper, demand bar, badge), 02 cart (note, info box, fixed bar, disabled/enabled submit — never press it), 03 continue-adding round trip, 04 search (history, results), 05 cuenta (stats real), 06 pedidos (tabs, detail, reorder → then clean the cart), 07 perfil/direcciones. Repeat the pass in **es** and at ≥1024 desktop (top icon nav, no tab bar, panes still work).
- [ ] A11y spot-check: tab-bar `aria-current` + badge label, rail nav label + `aria-current`, stepper focus survives 0→1→0 (keyboard), search × / 清除 labels, all icon-only controls named; contrast — brand-ink on white ≥4.5, white on brand ≥4.5, faint text used only ≥18px-equivalent or non-essential.
- [ ] Staff smoke as **staff-test**: home, pedidos queue, productos, ajustes render coherently on the new tokens (solid cards, no dead blur artifacts, drawer works on mobile width). Screenshots.
- [ ] Owner-switch matrix: flip `show_prices` ON as owner → catalog/cart/orders show euros everywhere they should, demand bar shows subtotal; flip back OFF (production state). Same for `show_delivery_date` if quick. Restore both.
- [ ] Leave no test residue: cart empty, favorites as found, settings restored. Report: gate numbers, screenshot index, deviations found + fixed, anything deferred.
- [ ] If fixes were needed: gate again, commit `fix(client): verification pass fixes`.

---

## Self-review notes

- **Spec coverage:** design 01 → T2 (rail/list) + T5 (tab bar, demand bar, header) + notice bar (T2); 02 → T6; 03 → decision 8 (catalog IS the add-more mode, 继续加货 link in T6); 04 → T3; 05 → T4; 06 → T7; 07 → T8. Tokens/type/chips shared by all → T1. Mockup-only elements → locked decisions 1-2.
- **Order:** T1 tokens first (everything inherits); T2-T4 build the routes; T5 wires the shell to routes that now exist (no dead tabs mid-plan); T6-T7 restyle flows that depend on the shell's bar rules; T8 polish; T9 verify. Each task ends with working, gated software.
- **Type consistency:** `CARD` (not GLASS_CARD) from T1 used by T2-T8; `STEPPER_WRAP/DEC/INC/QTY` defined T1, consumed T1 (qty-stepper) only — pages import the component, not the classes; `ACTIVE_ORDER_STATUSES` defined T4, reused T7; `cartUnits`/`units` defined T5, T6 computes its own server-side sum (deliberate — different data source, noted in T6); `ProductRow` moved in T2, imported by T3; `madridMonthStartIso` defined T4 with tests.
- **No placeholders:** every step names exact files, classes, keys, and behaviors; the three non-trivial pure helpers carry signatures/impl sketches + test cases; queries name exact columns.
