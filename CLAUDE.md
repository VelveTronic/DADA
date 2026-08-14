# DADA Portal

B2B ordering portal for DADA Distribución (Spanish food wholesaler; customers are Chinese restaurants). Orders flow to the on-prem Wingest ERP via an outbound-polling bridge.

## Conventions (non-negotiable)
- Money = integer cents everywhere (`unit_price_cents`). Quantities = `numeric(10,3)` / `number` (weighed products).
- Product/category names = `jsonb {"es": "...", "zh": "..."}`; UI locale zh (default) or es; zh falls back to es.
- Prices are NEVER trusted from the client. `create_order` re-resolves prices server-side from the company's tarifa (tier 1..6 → `price_N_cents`).
- All order writes go through SECURITY DEFINER RPCs. No direct INSERT policies. RLS on every table; catalog requires login.
- DB migrations: SQL files in `supabase/migrations/` (source of truth), applied to cloud project `gudiykhngonoqsjoigza` via Supabase MCP `apply_migration`. Never `db push`.
- Package manager: pnpm. Gate before commit: `pnpm lint; pnpm typecheck; pnpm test; pnpm build`.
- ERP glossary: codart=SKU, codcli=customer no., tarcli=price tier, numped/numalb=ERP doc numbers (bridge writes them back).

## Framework note
Next.js 16 has breaking changes vs training data. Before writing framework-level code (routing, middleware/proxy, config), read @AGENTS.md and the relevant guide under node_modules/next/dist/docs/.
