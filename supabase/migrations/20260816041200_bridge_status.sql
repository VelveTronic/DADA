-- bridge_status: one row per bridge job, overwritten by every run.
--
-- The bridge runs on the ERP server, behind the customer's router, with no
-- inbound anything. This table is the only place it can say "I am alive": each
-- run upserts {job, last_run_at, ok, detail} on the way out (see
-- src/bridge/main.ts), and the staff home reads the three rows back.
--
-- It is a STATUS table, not a history: one row per job, primary key on `job`,
-- last writer wins. A run log already exists — `bridge.log` beside the bundle,
-- which is where an operator goes to read what happened — and a growing table
-- nobody prunes would be a second, worse copy of it.
--
-- `last_run_at` and `ok` are NOT NULL because a row with either missing carries
-- no information the card could render; `detail` is nullable jsonb and holds the
-- job's counts (claimed/injected/… ) on success and a `code` on failure.
create table public.bridge_status (
  job text primary key,
  last_run_at timestamptz not null,
  ok boolean not null,
  detail jsonb
);

comment on table public.bridge_status is
  'Heartbeat, one row per bridge job (orders, albaran-sync, price-sync). Written by the service role only; read by staff.';

alter table public.bridge_status enable row level security;

-- Staff read. There is no insert/update/delete policy on purpose: the only
-- writer is the bridge, which holds the service-role key and bypasses RLS, and
-- an authenticated session that could write here could forge a green light on a
-- bridge that has been dead for a week.
-- `(select private.is_staff())` — the InitPlan wrapper every policy in this
-- schema uses, so the helper runs once per statement instead of once per row.
create policy bridge_status_staff_read on public.bridge_status
for select to authenticated
using ((select private.is_staff()));

-- Grants are the other half of RLS and they are not implied by it. Naming anon
-- and authenticated explicitly rather than relying on `from public`: on Supabase
-- those roles hold privileges of their own, and revoking from PUBLIC alone
-- leaves them untouched.
revoke all privileges on public.bridge_status from public, anon, authenticated;
grant select on public.bridge_status to authenticated;
grant all privileges on public.bridge_status to service_role;
