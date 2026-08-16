-- companies.address_city — the one piece of a delivery address the table lacked.
--
-- Plan 09 Task 2 asks for four columns (address, address_city, address_postal,
-- address_phone). Three of them have existed since 0001_core under the names the
-- rest of the system already uses: `address` (street), `postal_code`, `phone`.
-- Adding a second spelling of each would leave `/direcciones` choosing between
-- two columns for the street and the staff tooling writing whichever one it
-- happened to know about, so only the genuinely missing field is added here.
--
-- Nullable and staff-maintained: a restaurant READS this on /direcciones and is
-- told to ring DADA to change it. No policy change — `companies_select` already
-- narrows a customer to their own row and opens the whole table to staff.
alter table public.companies add column address_city text;

comment on column public.companies.address_city is
  'Delivery address: town/city. Staff-maintained; shown read-only on /direcciones.';

-- Grants are NOT inherited by a new column here, and that is the trap this block
-- exists to close. `authenticated` holds SELECT on companies as a COLUMN-LEVEL
-- grant (`security_order_integrity`, so that `notes` stays invisible), and a
-- column-level grant covers exactly the columns it names: a column added
-- afterwards is readable by nobody, and the address card would come back empty
-- with a 403 on the whole select.
--
-- The other privileges need no restatement, verified against the live project
-- before writing this: INSERT/UPDATE/DELETE are held table-wide by
-- `authenticated` (RLS narrows them to staff) and service_role holds every
-- privilege table-wide — both automatically extend to a new column.
grant select (address_city) on public.companies to authenticated;
