-- 0003b_orders_hygiene: post-apply tidy from the Task 6 implementer's concerns.
-- FK indexes (advisor INFO): repeat-last-order resolves order_items.product_id;
-- staff per-user views will filter on orders.placed_by.
create index orders_placed_by on public.orders(placed_by);
create index order_items_product on public.order_items(product_id);
-- Sequence ACL: Supabase default privileges grant USAGE on new sequences to
-- anon/authenticated; nothing outside create_order (SECURITY DEFINER, owner postgres)
-- should mint order numbers.
revoke all on sequence public.order_number_seq from public, anon, authenticated;
-- Accepted security-advisor baseline as of this migration: 3 WARNs
-- (authenticated_security_definer_function_executable on is_staff, my_company_id,
-- create_order - false positives; authenticated MUST call all three) plus 1 ERROR
-- (security_definer_view on products_priced - deliberate, see 0002c/0002d comments).
-- Anything beyond this baseline is a regression.
