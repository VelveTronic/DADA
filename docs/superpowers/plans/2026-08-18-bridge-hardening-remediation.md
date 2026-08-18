# Bridge Hardening Remediation Implementation Plan

> **For agentic workers:** Implement this plan task-by-task with a test-first
> cycle. The current working tree already contains the earlier hardening batch;
> preserve those changes and do not reset or discard them.

**Goal:** Close the remaining review findings F1–F7 without claiming the ERP
year-end gate is complete before historical data is verified.

**Architecture:** Keep `erp_can`/`erp_eje` and the new `albaran_can`/`albaran_eje`
nullable during rollout. New injections write the Pedido identity immediately;
the Bridge resolves missing historical identities from Wingest
`pedclica`/`pedclicah`, then calls a service-role-only backfill RPC. Albarán
matching uses the persisted Pedido identity only as a bounded search scope and
stores the actual Albarán row identity returned by `albfacca`.

**Tech Stack:** PostgreSQL/Supabase SQL migrations and pgTAP, TypeScript,
Vitest, Node filesystem locks, raw PostgREST Bridge client, SQL Server `mssql`.

## Global Constraints

- Do not hardcode historical CAN values in a PostgreSQL migration.
- `albaran_eje` is independent from `erp_eje`; the row returned by `albfacca`
  is authoritative.
- `bridge_status.ok` means the job completed its run; business data problems
  belong in counters and business health.
- Do not expose Bridge error columns or identity mutation RPCs to
  `authenticated`/`anon`.
- Follow the repository command gate where available:
  `pnpm lint; pnpm typecheck; pnpm test; pnpm build`.
- The local environment has no usable PostgreSQL/Supabase/Docker, so database
  tests must be statically checked and explicitly reported as unexecuted.
- Do not commit or push unless the user explicitly asks.

---

### Task 1: Make ERP and Albarán identity migration rollout-safe

**Files:**
- Modify: `supabase/migrations/20260817120000_erp_pedido_identity.sql`
- Modify: `supabase/tests/database/erp_pedido_identity.test.sql`

**Interfaces:**
- Add nullable `orders.albaran_can text` and `orders.albaran_eje integer`.
- Add service-role-only `bridge_backfill_order_identity(uuid,text,integer,integer)`.
- Change `bridge_mark_albaran` to accept and persist
  `(order_id, albaran_can, albaran_eje, numalb)`.

**Steps:**

- [ ] Write pgTAP assertions for both Albarán columns, the backfill RPC ACL,
  the four-argument Albarán mark RPC, and nullable rollout compatibility.
- [ ] Remove the SQL update that assigns `'B'`/`26` to every existing order.
- [ ] Keep only shape/range checks for nullable identity columns; defer
  completeness and final identity constraints until the ERP validation pass.
- [ ] Make the backfill RPC update only an existing `injected`/`albaran` order
  whose `numped` matches the supplied value and whose Pedido identity is
  currently incomplete.
- [ ] Make `bridge_mark_albaran` validate and atomically write the actual
  Albarán CAN/EJE/NUMALB while preserving the Pedido identity.
- [ ] Run the focused SQL text/shape checks and update the generated database
  types after the SQL contract is stable.

### Task 2: Extend the Bridge Supabase contract for historical identity

**Files:**
- Modify: `src/bridge/supabase.ts`
- Modify: `src/bridge/supabase.test.ts`
- Modify: `src/lib/supabase/database.types.ts`

**Interfaces:**
- `InjectedOrderRef` includes `orderNumber`.
- `BridgeSupabase.backfillOrderIdentity(orderId, can, eje, numped)`.
- `BridgeSupabase.markAlbaran(orderId, can, eje, numalb)`.

**Steps:**

- [ ] Add failing HTTP contract tests for the new RPC payloads and the
  `order_number` response field.
- [ ] Implement strict validation for `order_number`, identity values, and
  numeric ERP values.
- [ ] Keep identity mutation calls service-role-only at the SQL ACL and client
  boundary.

### Task 3: Resolve historical Pedido identity from Wingest and match cross-year Albarán

**Files:**
- Modify: `src/bridge/jobs/albaran-sync.ts`
- Modify: `src/bridge/jobs/albaran-sync.test.ts`
- Modify: `docs/bridge-runbook.md`

**Interfaces:**
- Add a parameterized historical Pedido lookup against `pedclica` and
  `pedclicah`, matching both `NUMPED` and `NUMPEDCLI = PORTAL-<order_number>`.
- Albarán query returns `CAN`, `EJEALB`, `NUMPED`, and `NUMALB`.

**Steps:**

- [ ] Add failing tests proving a missing Pedido identity is resolved from ERP
  and a December Pedido can match an Albarán with `EJEALB = erp_eje + 1`.
- [ ] Hydrate missing identities through the backfill RPC before indexing
  Albarán candidates.
- [ ] Query Albarán candidates by CAN and NUMPED with a bounded
  `EJEALB IN (erp_eje, erp_eje + 1)` scope; never equate Albarán EJE with
  Pedido EJE.
- [ ] Persist the returned Albarán CAN/EJE/NUMALB and include the independent
  identity in logs and tests.
- [ ] Document the historical replay order and the requirement to validate
  ERP results before enabling final database constraints.

### Task 4: Count lease claims and terminate exhausted crash loops

**Files:**
- Modify: `supabase/migrations/20260817100000_bridge_failure_recovery.sql`
- Modify: `supabase/tests/database/bridge_failure_recovery.test.sql`
- Modify: `src/bridge/jobs/orders.test.ts`

**Steps:**

- [ ] Add a failing SQL assertion for a stale lease being counted as a new
  attempt and for an exhausted stale lease entering `bridge_failed`.
- [ ] Increment the attempt count when a row is newly claimed, including stale
  lease recovery; replayed same-token claims must not increment.
- [ ] Make `bridge_mark_order_failed` consume the current claim attempt rather
  than incrementing a second time, with first-failure backoff at one minute and
  attempt five terminal.
- [ ] Add an atomic terminal transition for an expired processing lease already
  at the attempt ceiling.
- [ ] Update Bridge tally/comment tests to reflect attempts counted at claim
  time while preserving successful injection reset semantics.

### Task 5: Reclaim crashed lock mutation sidecars

**Files:**
- Modify: `src/bridge/lock.ts`
- Modify: `src/bridge/lock.test.ts`

**Steps:**

- [ ] Add a failing test that creates an expired mutation sidecar and verifies
  a stale lock can be taken over.
- [ ] Treat a mutation sidecar as held only while it is newer than the same
  mutation TTL; reclaim an expired sidecar using the same generation check.
- [ ] Keep replacement-owner and uncertain-PID fail-closed behavior unchanged.

### Task 6: Preserve heartbeat semantics and label Albarán business failures

**Files:**
- Modify: `src/bridge/jobs/albaran-sync.ts`
- Modify: `src/lib/bridge-status.ts`
- Modify: `src/lib/bridge-status.test.ts`
- Modify: `messages/zh.json`
- Modify: `messages/es.json`
- Modify: `src/i18n/messages.test.ts`

**Steps:**

- [ ] Add failing tests that a completed Albarán run with missing identities has
  `ok: true` but degraded/failed business health.
- [ ] Add `failed` to the Albarán counter label map and localized messages.
- [ ] Extend business-health derivation for `albaran-sync` without applying
  order-only counters to price-sync.

### Task 7: Defense-in-depth redaction in the failure RPC

**Files:**
- Modify: `supabase/migrations/20260817100000_bridge_failure_recovery.sql`
- Modify: `supabase/tests/database/bridge_failure_recovery.test.sql`

**Steps:**

- [ ] Add a failing pgTAP assertion that password/token/secret-shaped values
  are not returned by the staff failure reader.
- [ ] Normalize and redact common credential assignments and connection URI
  forms before applying the 1000-character bound.
- [ ] Preserve the existing rule that error messages never enter customer
  order events.

### Task 8: Verify the complete remediation

**Files:**
- No production file changes.

**Steps:**

- [ ] Run focused Vitest suites after each TypeScript task.
- [ ] Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build`.
- [ ] Run `pnpm db:test` only if the environment provides a working local
  Supabase; otherwise record the environment blocker and perform static
  `plan(N)`/assertion and migration contract checks.
- [ ] Inspect `git diff` and `git status`; do not commit or push.
