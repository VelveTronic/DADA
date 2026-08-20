# DADA Portal — Plan 14: Staff Admin Redesign (商家端后台, Claude Design) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. One Opus implementer per task, spec + quality dual review, fix round, verifier — the Plan 13 rhythm. Steps use checkbox syntax.

**Goal:** Rebuild the STAFF side of the portal to the owner's second Claude Design mockup — a desktop-first admin (sidebar nav + 今日 counts, dashboard home, orders queue, products table, **NEW category management**, clients view, settings) — on the same warm-beige token system Plan 13 shipped, without touching the security baseline.

**Architecture:** Pure UI + one new feature (categories CRUD). **Zero migrations, zero new RPCs**: `public.categories` is the one table that still carries authenticated staff write grants + `is_staff()` RLS policies (survey §3.2-3.3) — the category actions run on the SESSION client under RLS, exactly the escape hatch the hardening round left open. Product→category assignment uses the existing service-role idiom of `staff-products.ts`. Everything else reads what the pages already read, restyled, plus cheap `head:true` counts.

**Design source (the spec):** `docs/design/dada-staff-admin.dc.html` — one 1440×940 frame, six screens switched by the left nav. Inline styles ARE the spec. `support.js` is canvas runtime — ignore. The customer-side spec (`dada-mobile-client.dc.html`) and Plan 13's shipped tokens are the palette authority.

---

## Locked design decisions (deviations from the mockup are DELIBERATE — do not "fix" them)

1. **The mockup's order-flow fantasy is not product.** 报价/待客户确认/待发货/排车/催确认/复制单/批量报价 do not exist — the real flow is the 7-status machine (submitted → confirmed → processing → injected → albaran / cancelled / bridge_failed) with `staff_confirm_order`/`staff_cancel_order`/`staff_requeue_order`/`staff_update_order_line`. The queue keeps its REAL tabs (`QUEUE_TABS`), real chips (`OrderStatusBadge`), real actions. Mockup CTA verbs are replaced by the real ones.
2. **No inventory.** 库存/缺货预警数量/仅 N 箱 have no data. The real signal is `is_available` (断货) and `is_current_variant`. "缺货预警" surfaces become "停售商品" (is_available = false — the STAFF-side word already shipped as 停售/Pausado on the productos toggle; 断货/Agotado is the customer catalogue's word for the same column; A1 shipped 停售商品 and A5 must match). Products table has NO 库存 column.
3. **Out of scope, no backends:** 代客下单, 导出 Excel/名单, 批量导入, ＋新建商品 (products come from the freepos import), ⌘K global search, 渠道 column (手机端/客服代下 — not recorded), 结算方式 (月结/现结), 待跟进/待审核 client states, sub-categories as an editable tree (`parent_label` is a display label, NOT a hierarchy — survey §3.1), drag-and-drop reorder (no DnD dep; reorder = 上移/下移 buttons, keyboard-accessible), product ordering INSIDE a category (products carry no sort column; the catalog sorts by codart — mockup's 分类内商品拖动排序 is OUT).
4. **The portal keeps features the mockup omits:** the bridge heartbeat panel (today's staff home — operationally critical, it STAYS on the dashboard), the bridge-failure red box + requeue on the queue, per-line qty editing, the price-tier `n/6` column on products, the staff-accounts card (owner-only) on the clients page, zh/es staff i18n, the responsive drawer/icon-rail sidebar mechanics (mockup is desktop-only; our < lg behavior keeps its current contracts — especially the backdrop-filter containing-block rule in `staff-sidebar.tsx:306-321`: never add filter/transform/perspective/will-change/contain to the top bar).
5. **Categories are portal-owned.** Nothing automated writes them (survey §3.6). Staff-created categories get a synthetic `erp_code` `p<epoch-ms>` from a pure helper (injected clock, tested); the freepos numeric codes never collide with the `p` prefix. **No delete** (mockup has none; FK is RESTRICT anyway) — 隐藏 (is_active=false) is the retirement path. New categories are created **hidden by default** (empty category in the customer rail would confuse; the UI copy says so). Hiding a category removes its rail entry; its products remain reachable under 全部 — the detail pane says that too.
6. **Rail order = this page's order, by construction.** The catalog's app-side comparator moves from `catalogo/page.tsx` into `src/lib/categories.ts` and BOTH surfaces import it. 上移/下移 re-sequences `sort_order` to strict 10/20/30… steps on first write (freepos sort values collide today — survey §3.4).
7. **Nav relabel, not route churn:** `/staff/usuarios` keeps its URL; its nav entry and title become 客户/Clientes (the page already IS customers-first + owner-only staff card). New nav entry 分类 → `/staff/categorias`. Nav order per mockup: 首页 订单 商品 分类 客户 设置 (users/settings gating unchanged).
8. **Sidebar backlog block + 订单 badge are real counts** (submitted / bridge_failed / 停售), read by StaffShell (server) as three parallel `head:true` counts AFTER the page's own guard and reads — one extra round trip per staff page, accepted deliberately so the guard module (`guards.ts`) stays free of UI-count coupling (a `cache()` prefetch from `beginStaff` was reviewed and rejected in A1's round). Passed to the sidebar as props; a failed read renders an em dash, never 0. The block is labelled 待办/Por gestionar, NOT the mockup's 今日 — none of the three counts is day-scoped, so 今日 would lie. No polling.
9. **Settings page keeps the registry** (`SETTING_KEYS`: show_prices, show_delivery_date — whatever the registry holds). Mockup's 供应商资料/截单时间/起订量/通知 rows are OUT. The toggle look is restyled to the mockup's 44×26 track; `SettingsForm`'s hidden-`0` contract survives.
10. **AA over mockup literalism** (the five standing precedents): table headers, hint lines and any sole-carrier figure use `text-muted`, never `text-faint`; chips keep the shipped 7-state pairs; the mockup's #8C857E/#A8A099 12px copy maps to `text-muted` where it must be read.
11. **Admin surface tokens:** page wash `#FCFBFA` and card hairline `#EDE9E5` are the mockup's two admin one-offs — used via arbitrary values WITH the standard "not a token because" note (they appear only on /staff). Everything else maps to existing tokens: `#FBFAF9`=`bg-field`, `#E4DED8`=`border-border-strong`, `#F4F0EC` row rule (existing one-off), brand family, `#FDECEA`=`brand-soft`, active-nav `bg-brand-soft text-brand-ink` (mockup paints #E0231C text; letters take brand-ink — precedent).
12. **Role gates:** category writes = any active staff (matches the products-toggle precedent AND the existing RLS — tightening to manager+ would need an RPC and a baseline expansion; deliberately not done). Clients/settings gating unchanged (`canManageUsers`/`canManageStaff`).

## Background facts for implementers

- **Gate before every commit:** `pnpm bridge:build && pnpm lint && pnpm typecheck && pnpm test && pnpm build`, all zero (baseline 889 tests / 27 files at plan start). Commits end with the two standard trailers. Controller pushes.
- Supabase egress from the CI container is BLOCKED: browser verification = the Plan 13 fixture technique (temp route under the real segment, real components, constant data, inert actions, deleted before commit). NEVER submit orders; no login.
- i18n zh+es parity is test-enforced; the staff namespace already carries 171 keys/locale; closed lists get `messages.test.ts` coverage (house pattern, survey §4).
- Write mechanisms by table (survey §2): categories = session client under RLS (new `staff-categories.ts`); products = service-role after staff assert (`staff-products.ts` idiom); orders = authenticated RPCs; users = GoTrue admin + RPCs; settings = service-role after owner gate. Do not move a write between mechanisms.
- The two byte-identical local `assertStaff()` copies (staff-products/staff-orders) converge into ONE shared helper when Task 3 touches those files — it throws (Server Action), never redirects.
- Result codes travel as `?result=<CODE>` validated against closed lists before use (survey §6j); rejected creates answer via `useActionState`.
- Every staff page: `force-dynamic`, `perfRun`/`perf.step`/`perf.end` idioms (service-role reads never raced; session reads raced with the guard).
- Next 16: `searchParams` is a Promise; read `AGENTS.md` first.

## Token/chip mapping (from the mockup's own values)

| Mockup | Ours |
|---|---|
| sidebar bg `#FBFAF9`, border `#EDE9E5` | `bg-field`, `border-[#EDE9E5]` (noted one-off) |
| pane wash `#FCFBFA` | `bg-[#FCFBFA]` (noted one-off) |
| card `#fff` border `#EDE9E5` radius 12 | white card, `border-[#EDE9E5]`, `rounded-xl` (12px — the ADMIN card radius; customer `rounded-card` 14px stays customer-side) |
| active nav `#FDECEA`+`#E0231C` | `bg-brand-soft text-brand-ink font-bold` |
| chips quote/confirm/ship/done/off | the shipped `OrderStatusBadge` pairs; `off` = `bg-surface-dim text-muted` |
| filter chip active `#1C1917` white | `bg-ink text-white font-semibold` |
| table header row `#FBFAF9` text 11.5px `#8C857E` | `bg-field text-[11.5px] text-muted` |
| KPI number 34px Archivo | `font-num text-[34px] font-bold tabular-nums` |
| funnel bar colors `#E0231C/#F0806A/#C4B7AC/#1C1917` | one-offs with note (data-vis ramp, admin-only) |
| toggle track 44×26 on/off `#E0231C`/`#E4DED8` | restyle `SettingsForm` peer classes |

---

### Task A1: Staff shell redesign — sidebar per mockup + real 今日 counts + nav additions

**Files:** modify `src/components/staff-shell.tsx`, `src/components/staff-sidebar.tsx`, `src/components/icons.tsx` (add a Grid/Tag glyph for 分类), `messages/zh.json`, `messages/es.json`.

- [x] `StaffNavKey` gains `"categories"` (5-edit checklist, survey §6g): union, `NAV_PATH` (`/staff/categorias`), `NAV_ICON` (new 2×2-squares glyph in icons.tsx redrawn on the house 24-grid, `ICON_PROPS`), gate list (ungated — any staff), `staff.nav.categories` 分类/Categorías. Relabel `staff.nav.users` 用户→客户 / Usuarios→Clientes (key stays `users`).
- [x] StaffShell reads THREE parallel `head:true` counts under one `perf.step("counts")` in its OWN `perfRun` (after the page's guard — see amended decision 8): orders where status=submitted; orders where status=bridge_failed; products where is_available=false (service-role NOT needed — orders/products session reads under staff RLS are already how /staff/pedidos reads). Pass `{submitted, bridgeFailed, unavailable}` (`number|null`, null = failed read, drawn as —) to the sidebar. The null-vs-0 decision is pinned in `src/lib/shell-counts.ts` + table tests.
- [x] Sidebar lg=240px look per mockup: brand row (28px mark + DADA + 商家/Interno badge `text-[10.5px] border border-border-strong rounded px-1 text-muted`), nav rows rail/desktop `h-11 lg:h-[38px]` (drawer keeps `min-h-11`) `rounded-lg px-3 gap-2.5 text-[13.5px]` active `bg-brand-soft text-brand-ink font-bold` + 18px icons (row-scoped `[&_svg]:size-[18px]`); 订单 row badge `min-w-5 h-5 rounded-full bg-brand text-white font-num text-[11px] font-bold` showing `submitted` (hidden at 0/null; count spoken via the link's aria-label whenever present); divider; backlog block 待办/Por gestionar (label `text-[11px] font-semibold tracking-wide text-muted` as a `<p>`, not a heading + three `text-ink-soft` rows label/number reusing tabSubmitted/tabBridgeFailed + 停售商品, bridge_failed figure `text-brand-ink` when >0); footer user card (initial disc `bg-surface-dim`, name `text-[12.5px] font-semibold`, role label `text-[11px] text-muted`) — logout row kept. Badge/backlog/user-card hidden on the sm icon rail (caption precedent), all shown in the drawer.
- [x] Icon rail (sm) + drawer (<sm) keep every documented contract (focus return, Escape, matchMedia close, NO filters on the bar). Mockup's ⌘K search: OUT.
- [x] Gate. Fixture: sidebar at lg/sm/drawer with counts {5,1,6}, {0,0,0} and {null,null,null}; active states per path; screenshots. (Shipped: 82/82 + 43/43 assertions across the two rounds.)
- [x] Commit — shipped as `d287a3b` `feat(staff): admin sidebar per mockup — backlog counts, categories entry, 客户 relabel` + fix round `b36f013` `fix(staff): sidebar review round — honest null counts, 44px rail rows, ink-soft ladder`.

### Task A2: 分类管理 — /staff/categorias (the new feature)

**Files:** create `src/app/[locale]/staff/categorias/page.tsx`, `src/app/[locale]/staff/categorias/` client leaves as needed, `src/app/actions/staff-categories.ts`, `src/lib/categories.ts` + `src/lib/categories.test.ts`; modify `src/app/[locale]/catalogo/page.tsx` (import the extracted comparator), `messages/zh.json`, `messages/es.json`, `src/i18n/messages.test.ts` (closed-list coverage).

- [x] **`src/lib/categories.ts`** (pure): extract the catalog's app-side comparator VERBATIM (same order the rail renders — move, don't fork; catalog imports it back); `resequence(rows): {id, sort_order}[]` → strict 10-step orders in comparator order; `moveCategory(rows, id, dir)` → new resequenced array or null at the edge; `makePortalErpCode(now: Date)` → `p<epoch-ms>`; `validateCategoryName(zh, es)` → trimmed jsonb honoring `categories_name_shape` (at least one of zh/es non-empty; both stored when given); `CATEGORY_ERRORS` closed list (`EMPTY_NAME`, `NOT_FOUND`, `EDGE`, `DB_ERROR`, …). Table-driven tests for all incl. comparator tie cases (freepos collisions) and resequence idempotence.
- [x] **`staff-categories.ts`** actions on the SESSION client (RLS `is_staff()` is the gate; a local staff assert throws first for UX): `createCategory(formData)` (zh+es names → hidden by default, `sort_order` = max+10, synthetic erp_code), `renameCategory`, `setCategoryActive`, `moveCategory(id, dir)` (reads all → lib move → batch upsert of changed rows). Every action revalidates `/staff/categorias` + both locales' `/catalogo` (the rail). Result codes per the house `?result=` convention; create uses `useActionState`.
- [x] **Page** (force-dynamic, requireStaff — session reads raced): two-pane per mockup `grid lg:grid-cols-[340px_1fr] gap-[18px] items-start`. LEFT card: header 一级分类 + count; rows `px-[18px] py-[13px] border-t border-[#F4F0EC] flex items-center gap-3` — ↑/↓ move buttons (32px targets, disabled at edges, `aria-label` naming the category), name (zh with es under it `text-[11px] text-muted`), `{n} 个商品` `font-num text-xs text-muted`, hidden rows get an 已隐藏 chip (`bg-surface-dim text-muted`); selected row (via `?cat=id`) `bg-brand-soft text-brand-ink font-bold` + `aria-current`. Counts = ONE grouped read (`products` select category_id → count in memory, or a head-count per category is N+1 — group in app from a single `select category_id` with limit high enough; document the bound).
- [x] RIGHT detail (selected or first): header name + `{n} 个商品 · 客户端排序第 {i} 位` + 重命名 form (zh + es FIELD inputs, save BTN) + 隐藏/显示 toggle form (with the copy from decision 5); `parent_label` shown read-only as 分组标签 when present; products-in-category list (read-only, thumb+name+codart, first 50, note when more); empty-category state. ＋新建一级分类 (header button per mockup) opens the create form card (zh+es name fields; explains hidden-by-default).
- [x] i18n `staff.categories.*` zh+es (title, listHead, newButton, moveUp/moveDown aria, hiddenChip, rename, show/hide + confirmCopy, productsHead, groupLabel, empty states, results.* for every CATEGORY_ERRORS member + ok) + messages.test closed-list check.
- [x] Gate. Fixture (real components, constant rows incl. tie sort_orders + a hidden one + zh-only name): move up/down re-orders and disables at edges; rename round-trip via inert action; hidden chip; selection; screenshots zh+es, lg + drawer width.
- [x] Commit `feat(staff): category management — rail order, rename, hide, create, zero new RPCs`.

### Task A3: Products page — mockup table + category assignment

**Files:** modify `src/app/[locale]/staff/productos/page.tsx`, `src/app/actions/staff-products.ts` (+shared assert convergence), `messages/zh.json`, `messages/es.json`.

- [x] Restyle to the mockup table look on the ADMIN card (12px radius, `#EDE9E5` hairline, header row `bg-field text-[11.5px] text-muted`, rows `min-h-16 hover:bg-[#FCFBFA]`): 商品 (44px thumb + name + `SKU {codart}` `font-num text-[11px] text-muted`) / **分类** (NEW: per-row `<select>` of active categories + 未分类, submits `setProductCategory` on change via a tiny client leaf OR a per-row form with 保存 — pick the house-consistent shape and justify) / 规格 (unitLabel) / 状态 (real chips: 在售=`is_available`, 断货, plus the current-variant badge as today) / 价格 n/6 (KEPT) / 操作 (the three existing toggles, restyled `BTN_QUIET`-family). NO 库存, NO 新建/导入 buttons; header sub-line = real counts (`共 {n} 个商品 · {m} 个分类`).
- [x] Category filter chips row per mockup (全部 + top categories by count + a `<select>` overflow for the rest — 61 chips don't fit; decide and document), filter via `?cat=` erp_code like the customer page; search + pager kept.
- [x] `setProductCategory(productId, categoryId|null)` in staff-products.ts (service-role after the CONVERGED shared staff assert — fold the two `assertStaff` copies into one exported helper in this task), validates category exists + active-or-hidden, revalidates productos + catalogo + buscar.
- [x] i18n additions; gate; fixture (assignment select posts the right ids; chips filter; table at 1280 + drawer width); commit `feat(staff): products table per mockup with category assignment`.

> Shipped: `63f2fcd` + fix round `6822b7f` (resolveCatFilter races fixed pre-read, carrito joined the product revalidation fan-out, isUuid on all four actions, formText/ADMIN_CARD converged; 1012 tests / 30 files).

### Task A4: Orders queue — mockup chrome on the real machine

**Files:** modify `src/app/[locale]/staff/pedidos/page.tsx`, `messages/zh.json`, `messages/es.json`.

- [x] Keep the ENTIRE information architecture (tabs=QUEUE_TABS, per-order card with lines `<details>`, line-qty forms, confirm/cancel/requeue, bridge-failure box, result banners). Restyle: page header per mockup (title + sub explaining the REAL flow: 客户提交 → 确认 → 注入 ERP → 出单); tab strip → mockup filter chips (active `bg-ink text-white`, real `head:true` counts per tab under one perf.step raced with the guard, null → label without a number via `readCount`); card = `ADMIN_CARD` + `#F4F0EC` dividers + `#FCFBFA` hover; order row header adopts the mockup's rhythm (单号 `font-num` with 提交时间 stacked under it, 客户名 semibold with codcli/交付/ERP meta stacked, chip + subtotal right) while KEEPING the expandable detail and every datum shown today; card footer states the truth the page never told: 共 {n} 单 (the active tab's real count) · 显示最新 50 when n > 50. Actions KEEP their shipped semantic colors (确认 solid brand / 取消 red-outline quiet, destructive stays red / 重新入队 amber outline beside the red failure box) restyled to the admin metrics only. OUT (mockup fantasy or unbuilt features, deviations noted in-code): checkbox column + 已选 bulk bar, 渠道 column, 联系人 (codcli is the real second line), 种类/件数 columns (line count lives on the details summary; a cajas+kg sum would lie), order search + date-range filter, numbered pager (the 50-cap is now HONEST in the footer; real pagination is an owner-priority follow-up).
- [x] Fix the HANDOFF debt: the `order_items` read gains `.order("order_id").order("sort_order").limit(1000)` + the truncation comment (mirror the customer fix).
- [x] Gate; fixture (all 7 chip states, failure box, line edit form); commit `feat(staff): orders queue in the admin chrome — real statuses, bounded lines read`.

> Shipped: `0ea44fa` + fix round `ad03fb9` (bounded lines read with the withheld-details guard, four raced tab chips via readCount, honest 50-cap footer, derived reads on one round). Commit subject says "real counts" where this bullet sketched "real statuses" — the shipped wording is the truer one.

### Task A5: Dashboard home — real KPIs + funnel + heartbeat

**Files:** modify `src/app/[locale]/staff/page.tsx`, `src/lib/orders.ts` (+test) if a helper is needed, `messages/zh.json`, `messages/es.json`.

- [x] KPI strip (4 cells, `font-num text-[34px]`): 今日订单 (created_at ≥ Madrid today — reuse `madridDay`/month helper family; add `madridDayStartIso` to orders.ts WITH tests — mind the DST flip days: unlike the month helper, the last Sundays of March/October ARE candidate days, so the noon-probe argument does not transfer; the tests must pin 2026-03-29 and 2026-10-25), 待确认 (submitted), 进行中 (confirmed+processing+injected), 停售商品 (products is_available=false — the staff word, decision 2). All `head:true` counts through `readCount`, one perf.step, null → em dash never 0; NO mockup deltas/+3 (no historical data); KPI3 gets an honest breakdown sub-line 已确认 {a} · 处理中 {b} · 已注入 {c}. Home title becomes 概览/Resumen with a Madrid-date sub-line (mockup 今日概览 over-claims: only KPI1 is day-scoped; 截单时间 is unbuilt — OUT).
- [x] 状态漏斗 card: the current non-terminal pipeline — bars for submitted/confirmed/processing/injected(+bridge_failed in red) sized relative to max, `font-num` counts; colors per the token-map ramp with the one-off note. Pure percentage math in a lib helper + test if non-trivial.
- [x] 最近订单 card: 6 latest orders (number, company, kinds?=skip if it needs the lines read — company+status+time only; 全部订单 → link to queue), real chips.
- [x] 停售商品 card (wash `#FFF8F7`/`#FBE4E2` per mockup — the two red-wash one-offs, noted): products is_available=false, name+codart, first 6, 去处理 → productos. 待处理事项 card: bridge_failed orders (real, each linking the queue) + oldest submitted age; empty state 暂无待办 (the items are backlog, not day-scoped — 今日 would lie).
- [x] The bridge heartbeat card STAYS (restyled to the admin card look, TONE_CLASS intact).
- [x] Gate; fixture (counts {24,5,8,6} and all-zero; funnel with zero total); commit `feat(staff): dashboard — real KPIs, pipeline funnel, alerts, heartbeat kept`.

> Shipped: `eddaa8a` + fix round `78ae4e8` (DST-proof madridDayStartIso brute-forced over 17,520 hourly probes; counted todos footer; true RLS prose with the disclosed bridge_status exception; duration ages — no 昨天/ayer in age columns; 1031 tests / 30 files).

### Task A6: Clients page — mockup look on /staff/usuarios

**Files:** modify `src/app/[locale]/staff/usuarios/page.tsx`, `messages/zh.json`, `messages/es.json`.

- [x] Page title → 客户/Clientes. Customers half → mockup table look: initial-disc avatar (company name first char), name + `codcli` `font-num text-[11px] text-muted`, tarifa, contact rows (the portal_users under the company: display_name + email), 本月单量 (`head:true` count per company is N+1 — ONE grouped read of this month's orders `select company_id` with the Madrid month helper, counted in memory; bound + comment), active chip (在售 pairs), actions = existing activate/deactivate + the create form (kept, restyled). Stats strip per mockup: 合作餐厅 / 本月下单客户 / 活跃账号 (real derivable numbers only).
- [x] Staff half (owner-only) keeps every mechanic (role select, self-lockout row, create form) restyled to the admin card.
- [x] Gate; fixture; commit `feat(staff): clients view per mockup — companies first, month counts, accounts kept`.

> Shipped: `07cee0d` + fix round `2912662` (company-grouped account book keyed by company_id, windowed month scan failing closed with an early ceiling return, three honest stats with the active-∩-ordered intersection, title transient closed; commit subject reads "clients view — companies first, real month counts" where this bullet sketched "per mockup").

### Task A7: Settings — admin cards + mockup toggle

**Files:** modify `src/app/[locale]/staff/ajustes/page.tsx`, `src/app/[locale]/staff/ajustes/settings-form.tsx`, `messages/zh.json`, `messages/es.json`.

- [x] One admin card per setting from the registry (unchanged list), mockup row anatomy (title 13.5px semibold + desc 12px muted left, control right); `SettingsForm` toggle restyled to the 44×26 track/20px knob (`peer-checked:bg-brand`, off `bg-border-strong`) — the sr-only checkbox + hidden-`0` contract byte-preserved; per-card save kept (mockup's global 保存修改 is OUT — our per-setting form is the safer real shape).
- [x] Gate; fixture (toggle both states, focus ring visible); commit `feat(staff): settings on the admin cards with the mockup toggle`.

> Shipped: `357162d` + fix round `2912662` (44×26/20/18 toggle on exact tokens, hidden-`0` contract byte-preserved, off-knob restored to bg-muted after the round caught a 1.33:1 regression; es subtitle «Opciones del portal de pedidos»; 1046 tests / 31 files).

### Task A8: Verification + HANDOFF

- [ ] Full gate from clean; cross-task final review (whole Plan-14 range): token one-off ledger (#FCFBFA/#EDE9E5/funnel ramp all noted), AA sweep on the new admin text, i18n parity + closed lists, security gates (supabase/ diff EMPTY, no new RPC, package.json untouched), staff mobile drawer intact, categories comparator single-source (catalog imports the lib).
- [ ] Recorded follow-ups from A1's round to close or hand off: `/cuenta`'s four head-count logs are blind the same way the shell's were (no status on an empty-body error — apply shell-counts' F2 fix there, or record in HANDOFF); accepted states to leave alone: dual brand-link names (sidebar «DADA» vs phone-bar 员工后台, both truthful) and the usuarios crumb-客户/title-用户管理 transient that A6 closes.
- [ ] A3-A5 ledger: converge the TD/TH header/cell constants now duplicated across productos/pedidos/staff-home into ui.ts (byte-identical strings); normalise `profile.customerNo` es «Nº» → «N.º» to match `staff.colOrder`; the cache() count unification now has THREE readers (shell + queue chips + dashboard — same submitted/bridge_failed/paused predicates, up to 3 duplicate rounds per load) and rises in priority accordingly. Also: migrate the shell/home/queue inline count loggers onto lib/shell-counts' `readLoggedCount`; give the settings toggle's ON-state focus ring a `ring-offset-2` (brand ring on brand track reads as a fatter pill — pre-existing); fix `user-admin.ts:148`'s stale 用户管理 wording (page renamed 客户).
- [ ] Owner to-dos recorded (live walkthrough incl. category reorder against the real rail, staff-role matrix by logging in as each role).
- [ ] HANDOFF.md updated; push.

---

## Self-review notes

- Screen→task: sidebar→A1; 分类→A2 (+A3 assignment); 商品→A3; 订单→A4; 首页→A5; 客户→A6; 设置→A7. Every mockup fantasy is either locked out (decisions 1-3) or mapped to a real mechanism.
- Order: A1 first (nav must exist before /categorias ships — the entry 404s otherwise? No: A1 adds the entry pointing at a route that lands in A2 — SAME transition-404 mistake as Plan 13's search box. **Flip: A2 before A1's push? No — simpler: A1 and A2 land in the same push window; the branch is not production.** The controller pushes A1 only together with or after A2; noted for the controller, not the implementers.)
- Zero-RPC claim verified against survey §3.2-3.3 (grants + policies + sequence usage all present); the baseline paragraph in CLAUDE.md needs NO edit.
- Every new pure helper (comparator move, resequence, erp code, name validation, madridDayStartIso, month-count grouping if extracted) carries table-driven tests; closed lists get messages.test coverage.
