# Settings, Medusa-style UI, and Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Owner-editable project settings (starting with price visibility), a Medusa-v2-inspired UI overhaul (icon header + user dropdown on the storefront; sidebar admin), the mobile catalog card layout fix, two small account pages, and a measured performance pass on the ~400ms interaction latency.

**Architecture:** One `portal_settings` key/value table (authenticated read via RLS, owner-only writes through a gated server action). UI evolves the existing white/frosted-glass brand toward Medusa v2's structure — persistent left sidebar in the staff area, breadcrumb content shells, cleaner tables — without importing @medusajs/ui (Tailwind-only, study their open-source admin for layout/spacing/patterns: github.com/medusajs/medusa, packages/admin). Perf work is measure-first: instrument, parallelize the sequential Supabase round-trips, then re-measure.

**Owner decisions already made (2026-08-16):** prices stay ON by default (the owner flips the toggle themselves); staff pages always show prices; staff-test@dada.local has been promoted to `owner` (超级管理员) so the Settings tab is reachable; personal owner accounts are created by the owner via `pnpm user:create staff <email> <password> <name> owner` or the /staff/usuarios page.

**Background facts for implementers:** stock/断货 in the portal is a MANUAL staff toggle (`products.is_available`; `is_orderable` is the generated column gating orderability) — there is no quantity-based stock, by design; do not invent one in these tasks. `zh` is the default locale; every new string needs zh+es with key parity (typecheck enforces). Gate before every commit: `pnpm bridge:build` → `pnpm lint` → `pnpm typecheck` → `pnpm test` → `pnpm build`, all zero. Commits end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. Never push; the controller pushes after review.

---

### Task 1: portal_settings + owner Settings tab + price-visibility toggle

**Files:**
- Create: `supabase/migrations/<timestamp>_portal_settings.sql`
- Create: `src/lib/settings.ts` (typed read/write helpers + `SETTINGS_DEFAULTS`)
- Create: `src/lib/settings.test.ts`
- Create: `src/app/[locale]/staff/ajustes/page.tsx` + `settings-form.tsx`
- Create: `src/app/actions/staff-settings.ts`
- Modify: customer-facing price render sites (catalog page/product rows, cart page/cart lines/cart bar, checkout summary, order history + order detail lines) — every euro amount a CUSTOMER sees
- Modify: `src/components/app-shell.tsx` + `src/app/[locale]/staff/page.tsx` (设置 entry, owner-gated via `canManageStaff`)
- Modify: `messages/zh.json`, `messages/es.json`

- [ ] Migration: `portal_settings(key text primary key, value jsonb not null, updated_at timestamptz not null default now())`, RLS on; SELECT policy for authenticated (settings are not secrets; customers must read `show_prices`); writes only via service_role (no authenticated write policies); per-role revoke-then-grant per repo idiom. Seed `insert ... values ('show_prices','true'::jsonb)`. Apply via MCP apply_migration (classifier block → report BLOCKED); regenerate database.types.ts.
- [ ] `src/lib/settings.ts`: `getSetting(supabase, key)` returning parsed+validated value with default fallback (`show_prices` default true — a missing row or malformed value NEVER hides the whole catalog by accident); `SETTINGS` const registry `{ show_prices: { type: "boolean", default: true } }` so future settings are one registry entry. Table-driven tests: missing row → default, malformed jsonb → default, false → false.
- [ ] Server action `updateSetting`: `requireStaff` → `canManageStaff` (owner only) → validate key against the registry + value by type → service-role upsert → revalidate the affected paths. Never trust the key from the form beyond registry membership.
- [ ] `/staff/ajustes` (owner-only page, manager/staff redirect to /staff): one glass card "项目设置 / Ajustes", a labeled toggle for 显示商品价格 (zh: 关闭后客户端不再显示任何价格，员工后台不受影响; es equivalent), save via the action, `?result=` banner reusing the existing convention.
- [ ] Honor the flag: customer pages read `show_prices` once per request (server-side, alongside existing data fetches — do NOT add a client fetch) and when false render NO euro amounts anywhere a customer looks: catalog rows, cart lines/subtotal, cart bar total, checkout summary, order history amounts, order detail line prices. Layouts must not leave dangling labels ("金额:" with nothing after it) — hide the whole label+value pair. Staff pages (queue, productos, usuarios) are untouched and always show prices. `create_order` server logic unchanged (prices still resolved and stored — the toggle is display-only).
- [ ] Tests for whatever pure helpers you extract (e.g. a `formatPriceVisible`-style guard is NOT needed — prefer conditional rendering at the call sites; test settings.ts thoroughly instead). Gate. Commit `feat(settings): portal_settings with owner toggle for price visibility`.

### Task 2: storefront header — DADA logo, icon nav, user dropdown + two account pages

**Files:**
- Modify: `src/components/app-shell.tsx` (customer branch of the header)
- Create: `src/components/user-menu.tsx` (client dropdown)
- Create: `src/app/[locale]/perfil/page.tsx` + `profile-forms.tsx`
- Create: `src/app/[locale]/direcciones/page.tsx`
- Create: `src/app/actions/profile.ts`
- Create: `supabase/migrations/<timestamp>_companies_address.sql`
- Modify: `messages/zh.json`, `messages/es.json`

- [ ] Header (customer-facing only; staff header is Task 3's sidebar): brand = DADA logo mark + the word "DADA" — drop 订货平台 entirely. Right side, ICON buttons only (inline SVGs, stroke=currentColor, aria-label each, 24px): 商店 (storefront/home → catalogo), 搜索 (focuses/reveals the catalog search — simplest correct behavior: link to catalogo with autofocus param the search input honors), 购物车 (existing cart link+badge, keep the live badge), 用户 (opens dropdown). Active route gets the brand-ink accent. Mobile: same icon row, comfortable ≥44px touch targets.
- [ ] `user-menu.tsx`: client component, button with aria-expanded/aria-haspopup, dropdown glass panel with: 我的订单 (→ /pedidos), 我的配送地址 (→ /direcciones), 我的信息 (→ /perfil), divider, 退出登录 (posts the existing signOut action form). Close on outside click and Escape; focus returns to the trigger. No headless-ui dependency — hand-rolled with a ref + effect is fine at this size.
- [ ] Migration: `alter table public.companies add column address text, add column address_city text, add column address_postal text, add column address_phone text;` (nullable; staff-maintained). Column-level: readable by authenticated (customers see their own company via existing RLS; staff via staff policy) — no new policies needed, but re-check grants per repo idiom. Regenerate types.
- [ ] `/direcciones`: `requireCompanyUser`; shows the company's delivery address card (name, address fields, phone) with a note 地址有误请联系我们修改 / "Para modificarla, contacte con DADA" — read-only for customers (staff maintain data; editing UI for staff can come later). Empty state when no address on file.
- [ ] `/perfil`: `requireCompanyUser`; shows email (read-only), company name/codcli-free info, editable 显示名称 (updates `portal_users.display_name` via a server action gated on the session user's own row — use the AUTHENTICATED client, RLS `portal_users` self-update policy... CHECK the actual policies first: if authenticated self-update is not allowed by RLS, do the write via service-role keyed to `getSessionUser().id` ONLY — never a form-supplied id), and a 修改密码 form (current password + new password twice, both `PasswordInput`): re-authenticate with `signInWithPassword` against the session email, then `supabase.auth.updateUser({ password })` — this runs as the logged-in user, no admin client. Never log any password; errors map to message keys.
- [ ] Both new pages linked ONLY from the dropdown; guard redirects mirror existing pages. zh/es keys. Gate. Commit `feat(portal): icon header with user menu, profile and address pages`.

### Task 3: staff admin sidebar (Medusa v2 layout)

**Files:**
- Create: `src/components/staff-shell.tsx` (sidebar + content frame)
- Modify: `src/app/[locale]/staff/*/page.tsx` (all staff pages adopt the shell)
- Modify: `src/components/app-shell.tsx` (staff branch delegates to staff-shell or is bypassed)
- Modify: `messages/*.json`

- [ ] Study Medusa v2 admin layout first (github.com/medusajs/medusa, packages/admin — WebFetch the repo browser or docs screenshots; the reference images show: fixed left sidebar with org name top, flat nav list with icons, subtle hover states, main content with breadcrumb header and card-tables). Reproduce the STRUCTURE with our tokens (white/72% glass, brand red reserved for accents) — do not port their CSS wholesale, do not add dependencies.
- [ ] `staff-shell.tsx`: fixed/sticky left sidebar (collapsible to icons on <lg viewports, overlay drawer on mobile with a hamburger in a slim top bar): DADA mark + 员工后台, nav items with inline SVG icons — 首页(/staff), 订单(/staff/pedidos), 商品(/staff/productos), 用户(/staff/usuarios, `canManageUsers` only), 设置(/staff/ajustes, owner only), plus the signed-in identity + 退出登录 pinned at the bottom. Active item highlighted. Content area: max-width container, breadcrumb line (员工后台 / <page>), page title row.
- [ ] Migrate every staff page into the shell; the bridge-status card stays on 首页. Keep all existing functionality/tests intact — this is layout, not behavior. Tables (orders queue, product list, user lists) get Medusa-like density: row hover, muted column headers, aligned numeric columns.
- [ ] Customer-facing pages keep the Task 2 header (AppShell splits: customer → header shell, staff → sidebar shell; the ShellUser.role thread from Plan 08 already distinguishes them).
- [ ] Browser-verify layout at desktop + mobile widths (screenshot evidence). Gate. Commit `feat(staff): Medusa-style sidebar admin shell`.

### Task 4: catalog card layout + storefront polish (Medusa/TOKACHI pass)

**Files:**
- Modify: `src/app/[locale]/catalogo/*` (product row/card component)
- Modify: `src/components/cart/qty-stepper.tsx` styles if needed
- Modify: `messages/*.json` if any string changes

- [ ] Card layout bug (the user's screenshot): on mobile the +/stepper column must be a FIXED right-side column that the title can never overlap. Grid: `[thumb | min-w-0 flex-1 text+price | fixed-width action column]`; title gets `line-clamp-2` (two lines max, ellipsis), codart/unit line stays one line truncated; the action column (add button OR stepper after adding) keeps constant width in both states so nothing jumps or overlaps. Price sits under the title block (respecting Task 1's toggle).
- [ ] Polish pass referencing Medusa v2 + TOKACHI: consistent card radii/spacing rhythm, button sizing (≥44px touch), category chip bar styling, search field/button proportions on mobile (the current oversized red 搜索 block), empty states. Keep the white frosted-glass brand — this is refinement, not a rebrand.
- [ ] Browser-verify at 375px and desktop: long two-line title next to a stepper, no overlap, screenshot evidence. Gate. Commit `fix(catalog): fixed action column and two-line titles; storefront polish`.

### Task 5: performance — measure, fix the round-trip stacking, re-measure

**Files:** (led by evidence — expected hotspots)
- Modify: `src/lib/auth/guards.ts`, `src/proxy.ts`, heavy pages (`catalogo`, `carrito`, staff pages)
- Possibly create: `src/lib/perf.ts` (dev-only timing helper)

- [ ] MEASURE FIRST on a production build (`pnpm build && pnpm start` — dev/Turbopack latency is not the target): wrap the main request path with server-timing logs (guard, settings, data queries, total) and record numbers for: catalog load, add-to-cart action, checkout, staff queue. Report the baseline table.
- [ ] Known structural suspects to verify and fix where confirmed: ① guards do `getSessionUser()` then a profile query then page data SEQUENTIALLY — parallelize independent queries with `Promise.all` (guard result gates rendering, but the profile row and page data can race after the auth check); ② the proxy refreshes the session on every request including static-ish navigations — confirm scope, narrow matchers if safe (do NOT touch the refresh-before-intl ordering — that fixed a random-logout class); ③ repeated `createServerSupabase` cookie parsing per request is cheap — don't micro-optimize it; ④ cart actions revalidate broad paths — check whether `revalidatePath` scope forces full-page RSC re-renders where a narrower target works; ⑤ images: thumbnails already 48px fixed — verify no layout-shift or oversized fetches.
- [ ] Do NOT add caching layers that can serve one company's data (or prices) to another. Per-request dedup (React `cache()`) is fine; cross-request caches of authed data are not.
- [ ] Reality note for the report: SSR on localhost talks to Supabase eu-central-2 from Spain — every round trip is ~40-60ms of pure network; the deployed portal (Vercel eu region) will collapse most of it. State the measured before/after AND the expected deployed numbers honestly.
- [ ] Re-measure the same four flows; the deliverable is the before/after table + the diff. Gate. Commit `perf(portal): parallelize request path round-trips (measured)`.

---

## Self-review notes
- Spec coverage: price toggle + keep feature (T1); super admin with Settings tab (owner promotion done by controller + T1 page); mobile card overlap (T4); DADA-only brand + icon nav + user dropdown with the four entries (T2); Medusa reference for front (T4) and admin sidebar (T3); performance (T5). Out-of-stock question answered by the controller outside the plan (manual `is_available` toggle; no change requested).
- Order: T1 → T2 → T3 → T4 → T5 (T5 last so it measures the final UI; T2 before T3 so the shell split lands once).
- Types: `SETTINGS` registry name used consistently; `staff-shell.tsx` referenced by T3 only; no task references helpers another task hasn't defined.
