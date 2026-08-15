# DADA Portal — Plan 03b: Brand Restyle (white frosted glass + DADA logo)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Single task; checkbox steps.

**Goal:** Give the whole portal the owner-requested look — the TOKACHI-admin white minimal frosted-glass style — with the DADA logo (red sphere, white 東) as brand mark and favicon, committed deliberately to a single light theme.

**Reference recipe (from TOKACHI-2.0, verified in its source):** token-driven glass cards `rounded-[var(--radius-card)] border border-border bg-surface backdrop-blur-[14px]`, sticky header `sticky top-0 z-40 border-b border-border bg-background/85 backdrop-blur-[14px]`, generous radii, quiet borders. DADA adapts it white-first with the logo's red as the ONLY accent.

**Token plan (globals.css, Tailwind v4 `@theme`):**
- `--color-background: #F5F6F4` (soft warm-grey ground — glass needs a non-white ground to read)
- `--color-surface: rgb(255 255 255 / 0.72)` (the glass)
- `--color-border: rgb(30 32 30 / 0.08)`
- `--color-ink: #1D2021`; `--color-muted: #6B7075`
- `--color-brand: #E8192C` (from the logo sphere); `--color-brand-soft: #FDECEE`
- `--radius-card: 16px`
- Semantic banner colors (green/amber/red *-50/*-800 pairs) stay as they are — they are state, not brand.
- **Single-theme decision:** DELETE the existing half-implemented `prefers-color-scheme: dark` block in globals.css (nothing honors it; reviewer flagged AA failures under dark OS). The portal is deliberately light-only; paint `background` and text colors explicitly so it holds on any host. Document the decision in a css comment.

**Task (one commit per logical chunk, gate before each):**

- [ ] **1. Tokens + shell.** Rewrite `src/app/globals.css` theme block per the token plan (keep the CJK-aware font stack and any existing utility layers). Create `src/components/app-shell.tsx`: a server component `<AppShell locale user={...}>` rendering the sticky glass header — logo (`/brand/dada-logo.png`, 28px, `alt="DADA"`), app name from `common.appName`, nav links (customer: catalog/orders/cart-with-count; staff: products/queue), logout form — and a `<main className="mx-auto max-w-5xl px-4 pb-16">` slot. Two variants via a `nav` prop (customer/staff), links built from existing `nav.*`/`cart.cartLink`/`staff.*` messages (add keys ONLY if missing, both locales).
- [ ] **2. Favicon + logo assets.** `public/brand/dada-logo.png` is already staged in the repo. Copy it to `src/app/icon.png` (Next auto-generates the favicon from it; delete `src/app/favicon.ico`). Login page gets the logo centered above the title (~64px).
- [ ] **3. Apply to every page.** login, catalogo, carrito, pedidos, staff home, staff/productos, staff/pedidos: wrap content in AppShell (replacing each page's hand-rolled header/logout — deduplicate, don't duplicate); primary content blocks become glass cards (`rounded-[var(--radius-card)] border border-border bg-surface backdrop-blur-[14px]` + padding); primary buttons `bg-brand text-white` (replacing `bg-black`), links/active-tabs use brand; tab underlines brand; the favorites star keeps amber (it's a state, not brand). Tables/lists sit inside cards; keep all existing aria/sr-only/role attributes intact.
- [ ] **4. Status badge palette pass** (`order-status-badge.tsx`): keep semantic hues but differentiate `processing` (violet) from `injected` (blue) — the reviewer flagged them as identical.
- [ ] **5. Verify.** Full gate `pnpm lint; pnpm typecheck; pnpm test; pnpm build` 4×0 (no test count change expected; messages parity must stay green). `next start` probe: login page HTML contains the logo img and glass classes; cookie-less guards still 307; kill server, port freed. Grep: zero remaining `bg-black` primary buttons, zero `prefers-color-scheme` in globals.css, no page defines its own `<header>` outside AppShell.
- [ ] **6. Commit(s):** `feat(brand): glass tokens and app shell`, `feat(brand): apply frosted-glass style across all pages`. Do NOT push (controller pushes after visual review — the controller will LOOK at the pages in a browser before approving).
