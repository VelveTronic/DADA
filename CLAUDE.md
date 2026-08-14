# DADA Portal

B2B ordering portal for DADA Distribución (Spanish food wholesaler; customers are Chinese restaurants). Orders flow to the on-prem Wingest ERP via an outbound-polling bridge.

## Conventions (non-negotiable)
- Money = integer cents everywhere (`unit_price_cents`). Quantities = `numeric(10,3)` / `number` for ALL order lines (fractional exists for weighed products).
- Product/category names = `jsonb {"es": "...", "zh": "..."}`; UI locale zh (default) or es; zh falls back to es.
- Prices are NEVER trusted from the client. `create_order` re-resolves prices server-side from the company's tarifa (tier 1..6 → `price_N_cents`).
- All order writes go through SECURITY DEFINER RPCs. No direct INSERT policies. RLS on every table; catalog requires login.
- DB migrations: SQL files in `supabase/migrations/` (source of truth), applied to cloud project `gudiykhngonoqsjoigza` via Supabase MCP `apply_migration`. Never `db push`.
- Package manager: pnpm. Gate before commit: `pnpm lint; pnpm typecheck; pnpm test; pnpm build`.
- ERP glossary: codart=SKU, codcli=customer no., tarcli=price tier, numped/numalb=ERP doc numbers (bridge writes them back).
- Customer catalog reads go through the products_priced view (one computed price for the caller's tarifa). The six price_N_cents columns are NOT selectable by authenticated; staff tooling reads raw tiers server-side via the service role after the staff guard. Ordering gates on products.is_orderable (generated: is_available AND is_current_variant). Staff price edits also go through the service role (authenticated keeps INSERT/UPDATE on price columns but has no SELECT, so PostgREST return=representation would fail). Customer-side code must never select('*') on products (hard 403 — the six price columns are unreadable); read products_priced instead.
- Accepted security-advisor baseline: 3 WARNs (authenticated execute on is_staff / my_company_id / create_order — false positives; authenticated must call all three) + 1 ERROR (security_definer_view on products_priced — deliberate, see 0002c/0002d). Anything beyond this baseline is a regression.

## Framework note
Next.js 16 has breaking changes vs training data. Before writing framework-level code (routing, middleware/proxy, config), read @AGENTS.md and the relevant guide under node_modules/next/dist/docs/. In Next 16 the middleware file is `src/proxy.ts` (renamed from `middleware.ts`).
