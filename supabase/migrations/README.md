# Migration filenames

On 2026-08-18 seven migrations were renamed. The Supabase migration runner only
recognises files named `<digits>_<name>.sql`, and it **silently skips** anything
else — no warning, no error, just a shorter chain. The seven hardening/review
rounds were named `0001b`, `0001c`, `0002b`, `0002c`, `0002d`, `0003b` and
`0003c`; the letter made every one of them invisible to the runner. Local replay
(`supabase db start && supabase test db`, which is what CI's `database` job runs)
therefore applied only `0001_core → 0002_catalog → 0003_orders →
20260815101406_security_order_integrity` and died on
`column "albaran_at" does not exist` — `albaran_at` is added by the skipped
`0003c`. The rename gives all seven a timestamp version that sorts between
`0003_orders` and `20260815101406_security_order_integrity`, which restores the
order the cloud database was actually built in.

| Old name | New name |
| --- | --- |
| `0001b_core_hardening.sql` | `20260815000001_core_hardening.sql` |
| `0001c_core_forward_fixes.sql` | `20260815000002_core_forward_fixes.sql` |
| `0002b_catalog_hardening.sql` | `20260815000003_catalog_hardening.sql` |
| `0002c_catalog_review_fixes.sql` | `20260815000004_catalog_review_fixes.sql` |
| `0002d_catalog_view_availability.sql` | `20260815000005_catalog_view_availability.sql` |
| `0003b_orders_hygiene.sql` | `20260815000006_orders_hygiene.sql` |
| `0003c_orders_review_fixes.sql` | `20260815000007_orders_review_fixes.sql` |

Several of the seven refer to each other by the old names in their comments
("the same bug class `0001b` fixed", "see `0002c`/`0002d` comments"). Those
comments were left alone: they are the record of how the schema was reasoned
about at the time, and this table is how you resolve them.

## The cloud database never depended on these filenames

`gudiykhngonoqsjoigza` is built by applying each migration individually through
the Supabase MCP `apply_migration`, which records its own version in its own
ledger. Nothing there was skipped, and nothing there is affected by the rename —
this is a local-replay and CI fix only. Do not re-apply the renamed files to
cloud.

## What the rename changed about the order

The three base migrations kept their `0001`/`0002`/`0003` names, so the seven
rounds now run *after* all three rather than interleaved:

- was: `0001, 0001b, 0001c, 0002, 0002b, 0002c, 0002d, 0003, 0003b, 0003c`
- now: `0001, 0002, 0003, 0001b, 0001c, 0002b, 0002c, 0002d, 0003b, 0003c`

Only `0002` and `0003` moved earlier; the seven rounds keep their order relative
to each other, and `0003b`/`0003c` are still last. This is safe because each
round only touches objects its own base created, and neither base needs anything
a round adds at DDL time — `create_order` reads `products.is_orderable` (added by
`0002c`) but it is `plpgsql`, whose body is not name-resolved at `CREATE` time,
and every `language sql` function in `0003` references base columns only. The
final schema is identical either way, which is what `supabase test db` checks.

## Naming new migrations

Use `<UTC timestamp>_<snake_case_name>.sql`, e.g. `20260818143000_add_thing.sql`.
Never a letter suffix, and never a second file sharing a version — both are how
a migration stops existing as far as the runner is concerned.
