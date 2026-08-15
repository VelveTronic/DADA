# DADA Portal — Plan 05: Product Images & TOKACHI-style Cart UX

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Two independent tasks; checkbox steps.

**Goal:** (A) Bring the freepos image library (4,628 codart-named files in its filemanager `Product` folder) into Supabase Storage and onto the products; (B) replace the full-page-reload add-to-cart with TOKACHI's optimistic inline stepper pattern (`+` → `− qty +`), live header badge, and a mobile bottom cart bar.

## Task A — image pipeline (BLOCKED until the owner supplies either one real image URL from the filemanager, or a zip of the Product folder)

- [ ] 1. Source acquisition, two variants — implement whichever input exists:
  - `scripts/fetch-freepos-images.ts <base-url-pattern>` — derive per-codart URLs (try `.jpg/.jpeg/.png` per codart from our 2,971), download politely (concurrency ≤4, ~100ms spacing, retry once), into `scratch/freepos-images/` (git-ignored).
  - OR unzip the owner-provided archive there.
- [ ] 2. `scripts/upload-product-images.ts` — Supabase Storage bucket `product-images` (public read, service-role write; create if missing via storage API), upload matched-codart files as `<codart>.<ext>` with long cache-control, skip unmatched, then `update products set image_url = <public URL> where codart = ...`. Report: matched / uploaded / products-without-image. Idempotent (upsert: true).
- [ ] 3. UI: catalog rows + cart lines + staff products table render a 44–56px rounded thumbnail (`next/image`, `sizes` set) with a neutral placeholder block when `image_url` is null. `next.config.ts` gains the Supabase storage `remotePatterns` entry (TOKACHI has the exact shape).
- [ ] 4. Gate 4×0 + a real run report; browser spot-check.

## Task B — TOKACHI-style cart interactions (independent; start immediately)

**Reference (read these first):** TOKACHI-2.0 at the known scratchpad path — `src/components/cart/add-to-cart.tsx` (optimistic stepper), `src/components/cart/cart-bar.tsx` (mobile bottom bar), how its header badge stays live. Borrow the interaction mechanics; DADA keeps its httpOnly-cookie cart + server actions as the source of truth.

- [x] 1. `src/components/cart/cart-provider.tsx` (client): context seeded from the server-parsed cart (`{[productId]: qty}` passed as a prop by AppShell); exposes `qtyOf(id)`, `count`, `setQty(id, qty)` which optimistically updates local state and `startTransition`s the EXISTING server actions (`addToCart`/`setCartQty` form-data contract — call them as functions with a constructed FormData, or add thin `"use server"` wrappers taking plain args; keep cookie writes server-side only). On action failure, revert the optimistic state and surface the existing `?cartError` copy inline (small toast/banner).
- [x] 2. `src/components/cart/qty-stepper.tsx` (client): qty === 0 → single `+` button (disabled+title when unpriced/un-orderable, same conditions as today); qty > 0 → `− qty +` pill matching the glass style (`FIELD_SM`/`BTN_QUIET` tokens). Steppers replace the per-row add forms on the CATALOG page; the CART page keeps its editable number inputs (absolute qty) but swaps its per-line remove/update forms to the provider too so both views stay in sync without reloads.
- [x] 3. Header badge: AppShell renders the badge from the provider (client leaf inside the server shell — pass initial count, subscribe to context), so `+` clicks tick it instantly. Mobile bottom cart bar (`lg:hidden`, fixed, glass, safe-area padding — TOKACHI's cart-bar shape): line count + link to `/carrito`; show subtotal only when every line is priced (provider gets unit prices for on-page items only — the bar may show count-only when off-catalog; keep it simple and honest).
- [x] 4. Rules: NO price math client-side beyond display of already-rendered prices; the cookie remains authoritative (a reload must always agree); `CART_MAX_LINES`/`BAD_QTY` errors surface via the existing messages; all aria labels preserved (stepper buttons get `aria-label` add/decrease with {name}).
- [x] 5. Gate 4×0 (115 tests stay green; add unit tests for any new pure logic, e.g. an optimistic reducer if extracted). Runtime probe: logged-in browser session — click `+` three times on a priced product: badge ticks 0→1 (lines), qty pill shows 3, NO full page reload (document does not re-navigate), cart page agrees after hard reload. Guard redirects unchanged.
- [x] 6. Commits: `feat(cart): optimistic qty steppers and live badge (tokachi pattern)`, then UI-polish commit if needed. Do NOT push (controller browser-reviews first).
