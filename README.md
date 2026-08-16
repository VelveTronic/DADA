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

## Measuring a slow page (`PERF_LOG`)

The request path is instrumented. It is silent — no timer read, no line written —
unless `PERF_LOG=1` is set, and it must be measured on a PRODUCTION build:
`next dev` recompiles on demand and its numbers are not the portal's.

```text
pnpm build
$env:PERF_LOG=1; pnpm start        # PowerShell
PERF_LOG=1 pnpm start              # bash
```

Then sign in and use the portal normally — open the catalogue, press `+` on a
row, open the cart, place an order — and read the lines the server prints:

```text
[perf] proxy /zh/catalogo branch=session claims=0.4 total=1.1
[perf] #12 /zh/catalogo session=0.5 profile=13.9 categories=13.4 settings=13.1 favorites=12.6 products=25.2 total=39.4
```

- **`proxy`** is the session refresh, per request. `claims` is an upper bound on
  the JWT check (it also counts cookie parsing and client construction); on
  this project's ES256 signing keys the verify is local and the whole figure
  should read under a couple of milliseconds. Note `branch=anon|session` is a
  word, not a number — don't feed proxy lines to a parser expecting only
  numeric values. A `claims` that looks like a round trip means the tokens are being
  signed with the legacy symmetric secret and every request is calling the Auth
  server.
- **The numbered line** is one page render or one server action. Every step is
  wall time on the wire, so steps that ran TOGETHER overlap: `session + profile +
  categories + …` adding up to far more than `total` is what parallelism looks
  like here, and a `total` that equals the sum is a page that queued its queries
  one behind the other. Steps print in the order they were issued.
- Requests that end in a redirect (signed out, deactivated, a manager on an
  owner-only page) print the proxy line but no page line: they never reach the
  end of the page.

`total` covers the page's own data work, not the response. The wall-clock number
a browser sees is a few milliseconds more (routing, i18n and the React render):
the `/…/login` line is that floor on its own, since it reads nothing.

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
The count report is JSON on stdout and the anomalies go to stderr, so piping the
report needs pnpm's `--silent` to keep its lifecycle banner out of the pipe:

```text
pnpm --silent import:freepos --dry-run | jq .anomalies
```

Real prices and units arrive separately: the owner runs
`scripts/wingest/export-prices.ps1` on the ERP server (one read-only SELECT) and
`pnpm import:wingest-prices <prices.csv> [--dry-run]` merges the resulting CSV
into `products` by `codart`, turning zero tiers into NULL and deriving
`is_weighed` from the `KG` unit. That CSV is the full price matrix: it is
gitignored, and it should be deleted once the merge has run. Check the ERP's unit
vocabulary against the `KG` rule before writing anything:

```text
pnpm --silent import:wingest-prices prices.csv --dry-run | jq .unidadValues
```

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
