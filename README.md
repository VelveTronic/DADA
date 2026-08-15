# DADA Portal

Bilingual (中文/Español) B2B ordering portal for DADA Distribución. Restaurant
customers see company-specific prices and place orders; staff confirm them and
an outbound on-premises bridge transfers confirmed orders into Wingest.

## Stack

Next.js 16 App Router, React 19, TypeScript, Supabase Postgres/Auth, next-intl,
Tailwind CSS, Vitest and pgTAP.

## Local development

1. Install Node.js 22 and pnpm 10.15.0.
2. Run `pnpm install`.
3. Copy `.env.example` to `.env.local` and fill server-only secrets when needed.
4. Run `pnpm dev`.

Before opening a pull request, run:

```text
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

The CI workflow runs the same application gate. It also starts an isolated local
Supabase Postgres instance, replays every migration, and runs the database
contract suite.

## Authentication and users

The portal has two mutually exclusive user mappings: restaurant users in
`portal_users` and internal users in `staff_users`. Public signup is disabled
in the local configuration. Create users only from a trusted workstation after
setting `SUPABASE_SERVICE_ROLE_KEY` in `.env.local`:

```text
pnpm user:create staff <email> <password> <displayName> [role]
pnpm user:create customer <email> <password> <displayName> <companyName> <codcli> [tarcli]
```

Pass the arguments directly, with no `--` separator: pnpm 10 forwards script
arguments as they are and would hand the separator itself to the script.

## Database

SQL migrations in `supabase/migrations/` are the source of truth. They are
applied to project `gudiykhngonoqsjoigza` with Supabase MCP
`apply_migration`, never with `supabase db push`.

Load the product catalog from the freepos snapshot with
`pnpm import:freepos --dry-run` to preview counts and anomalies, then without the
flag to write; it is idempotent by `codart` and never writes price columns.

Customer catalog code reads `products_priced`. Staff access to raw price tiers
is server-only through the service-role client after `requireStaff`. Direct
authenticated updates to orders, price tiers and internal notes are denied;
order creation and staff state changes use the dedicated RPCs.

With Docker running, reproduce the database and run all 36 authorization and
order/bridge contract assertions:

```text
pnpm exec supabase db start
pnpm db:test
```

The bridge contract is lease-based: `bridge_claim_confirmed` moves claimed
orders to `processing`; `bridge_mark_injected` accepts only the same claim
token, and all mark functions return `false` when the expected transition did
not occur.

See `CLAUDE.md` for domain invariants and `docs/superpowers/plans/` for
delivery plans.
