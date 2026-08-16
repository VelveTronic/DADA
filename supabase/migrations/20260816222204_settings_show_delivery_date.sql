-- show_delivery_date: the owner's second switch, and the column comment that
-- says what its OFF position means in the data.
--
-- No schema change was needed for it, and that is worth writing down rather
-- than discovering again:
--
--   * `orders.delivery_date` has been `date` with no NOT NULL since 0003_orders
--     — a null has always been a legal value there.
--   * `create_order` has taken `p_delivery_date date default null` since the
--     same migration, and its range check has ALWAYS been guarded by
--     `p_delivery_date is not null` (see the v3 body in
--     20260816161500_bridge_caja_units.sql). Omitting the argument is therefore
--     already valid and already stores a null; BAD_DELIVERY_DATE keeps rejecting
--     a past or too-distant date whenever one IS given.
--   * The request hash is `jsonb_build_object('lines', …, 'delivery_date',
--     p_delivery_date, 'note', …)`, and jsonb_build_object renders a SQL null as
--     the JSON null under a key that is still present. An order placed with no
--     date therefore hashes exactly as it did before this switch existed, so the
--     idempotency replay of a pre-deploy cart is unchanged.
--   * `bridge_claim_confirmed` emits the same jsonb null, which the bridge reads
--     as "no date given" and resolves to the Madrid business day (resolveFecent
--     → FECENT, i.e. FECPED semantics).
--
-- So this migration is the SEED and the DOCUMENTATION, nothing else.

-- The default stated in the database as well as in the registry (SETTINGS in
-- src/lib/settings.ts): the picker is ON. `on conflict do nothing` so a re-run
-- against a project where the owner has already hidden it does not silently put
-- the date field back on every checkout — the same rule the show_prices seed
-- follows, for the same reason.
insert into public.portal_settings (key, value)
values ('show_delivery_date', 'true'::jsonb)
on conflict (key) do nothing;

comment on column public.orders.delivery_date is
  'The delivery date the customer asked for, or NULL when they were never asked: the owner setting show_delivery_date hides the checkout picker, and the bridge dates such a pedido on the Madrid business day (FECENT = FECPED). Never NULL-as-unknown for an order whose customer did choose — those keep their date on every screen.';
