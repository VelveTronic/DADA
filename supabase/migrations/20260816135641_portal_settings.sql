-- portal_settings: the owner's switches, one row per setting.
--
-- Today it holds exactly one — `show_prices`, which decides whether a CUSTOMER
-- sees euro amounts anywhere in the portal — but it is a key/value table rather
-- than a one-row `settings` table with a boolean column, because the next switch
-- must be a row and a registry entry (see `SETTINGS` in src/lib/settings.ts),
-- not a migration plus a schema change plus a regenerated types file.
--
-- `value` is jsonb so a setting can be a boolean today and a number, a string or
-- a small object later without the column type being the thing standing in the
-- way. Nothing here constrains WHICH keys exist: the application registry is the
-- closed list, and a check constraint naming the keys would mean a deploy could
-- not add one without a migration going out first.
--
-- `updated_at` is written by the server action on every upsert (the default only
-- covers the seed below); there is no history table on purpose — the value that
-- matters is the current one, and who flipped it is a question for the audit
-- log this deployment does not have yet.
create table public.portal_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

comment on table public.portal_settings is
  'Owner-editable portal settings, one row per key. Read by every signed-in user; written by the service role only (owner-gated server action).';

alter table public.portal_settings enable row level security;

-- EVERY authenticated user reads this table, staff and customers alike — which
-- is the difference from `bridge_status`, whose policy calls `private.is_staff()`.
-- It is deliberate and it is safe: a customer's catalogue has to know whether
-- prices are shown, that read happens server-side inside their own request, and
-- nothing in here is a secret. Gating it on staff would leave the customer pages
-- with no way to answer the question except the service-role key, which is a far
-- worse trade for a boolean the UI reveals anyway.
--
-- `using (true)` rather than a helper call: there is nothing to narrow. Every
-- row is readable by every role this policy applies to.
create policy portal_settings_read on public.portal_settings
for select to authenticated
using (true);

-- No insert/update/delete policy, on purpose. The only writer is
-- `updateSetting` (src/app/actions/staff-settings.ts), which holds the
-- service-role key and bypasses RLS after `requireStaff` + `canManageStaff` have
-- proved the caller is the owner. An authenticated session that could write here
-- could switch the whole catalogue's prices off for every restaurant.
--
-- Grants are the other half of RLS and they are not implied by it. Naming anon
-- and authenticated explicitly rather than relying on `from public`: on Supabase
-- those roles hold privileges of their own, and revoking from PUBLIC alone
-- leaves them untouched.
revoke all privileges on public.portal_settings from public, anon, authenticated;
grant select on public.portal_settings to authenticated;
grant all privileges on public.portal_settings to service_role;

-- The default the owner starts from, stated in the database as well as in the
-- registry: prices ON. `on conflict do nothing` so re-running this migration
-- against a project where the owner has already flipped the switch does not
-- silently turn every price back on.
insert into public.portal_settings (key, value)
values ('show_prices', 'true'::jsonb)
on conflict (key) do nothing;
