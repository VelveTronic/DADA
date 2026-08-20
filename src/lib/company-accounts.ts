/**
 * Putting the portal's customer ACCOUNTS under the restaurant each one belongs
 * to — the shape `/staff/usuarios` draws its client list in.
 *
 * The page reads one flat list (`portal_users` with its company embedded, oldest
 * account first) and has to render a two-level list: a restaurant, then the
 * logins that belong to it. That regrouping is three decisions, none of them
 * obvious from the markup they end up in, which is why they live here under a
 * table rather than inside the JSX:
 *
 *  1. **Which rows share a group.** `company_id`, not the company's NAME — two
 *     restaurants may be called the same thing, and the id is what the month's
 *     order tally is keyed by on the other side of the page.
 *  2. **What happens to a row whose restaurant did not come back.** It goes into
 *     one tail group with no company at all, and that group is always LAST. The
 *     page labels it 无关联餐厅 and renders no tarifa, no order count and no
 *     status chip for it, because there is no company to say those about. See
 *     the note on `id` below for why the case exists at all.
 *  3. **What order the restaurants come in.** The caller's comparator, applied
 *     to the company name — the page passes an `Intl.Collator` for the reader's
 *     locale, so zh sorts by pinyin and es by Spanish collation rather than both
 *     by UTF-16 code point. Ties keep the order the rows arrived in
 *     (`Array.prototype.sort` has been stable since ES2019), which is the
 *     query's `created_at`.
 *
 * Pure: no client, no request, no clock. The page keeps the reads.
 */

/**
 * As much of an account row as the grouping reads: which restaurant it belongs
 * to, and that restaurant's name to sort by. Callers pass their own wider row
 * type and get it back unchanged.
 */
type AccountLike = { company_id: string; companies: { name: string } | null };

/** One restaurant and the accounts that sign in under it. */
export type CompanyGroup<Account extends AccountLike> = {
  /**
   * `portal_users.company_id`, or `null` on the tail group.
   *
   * The column is `not null references public.companies(id)`
   * (`supabase/migrations/0001_core.sql:24`), so on today's schema every account
   * HAS a restaurant — supabase-js even infers the embedded company as non-null
   * from that FK (checked against this exact select), and the page's own
   * hand-written row type is what widens it back to `| null`. The tail group is
   * therefore unreachable in production, and it is kept because the alternative
   * to grouping such a row is DROPPING it: an account that can sign in, silently
   * missing from the page whose whole job is listing accounts. A visible group
   * with no company beats a row that is not drawn.
   */
  id: string | null;
  /** The restaurant — `null` on the tail group, and only there. */
  company: Account["companies"];
  /** Its accounts, in the order they arrived. */
  accounts: Account[];
};

/**
 * Group `accounts` by their company: restaurants first, ordered by `compare` on
 * the company name, and the company-less tail last.
 */
export function groupAccountsByCompany<Account extends AccountLike>(
  accounts: readonly Account[],
  compare: (a: string, b: string) => number,
): CompanyGroup<Account>[] {
  /** The groups that HAVE a company, keyed by the id that defines them. */
  const named = new Map<string, CompanyGroup<Account>>();
  const orphans: Account[] = [];

  for (const account of accounts) {
    const company = account.companies;
    if (!company) {
      orphans.push(account);
      continue;
    }
    const group = named.get(account.company_id);
    if (group) {
      group.accounts.push(account);
      continue;
    }
    // The FIRST row of each group carries the company snapshot the header is
    // drawn from. Every row of one group embeds the same company, so which one
    // it is taken from cannot matter.
    named.set(account.company_id, {
      id: account.company_id,
      company,
      accounts: [account],
    });
  }

  const groups = [...named.values()].sort((a, b) =>
    // Every group in `named` has a company by construction — the loop above puts
    // the company-less rows in `orphans` — so the `?? ""` fallbacks are
    // unreachable. They stay because the group TYPE, which has to admit the tail
    // group below, says nothing about which of the two kinds this is.
    compare(a.company?.name ?? "", b.company?.name ?? ""),
  );
  // Appended AFTER the sort, so no comparator can move it: a group with no name
  // has nothing to be sorted by, and its place is the end of the list.
  if (orphans.length > 0) {
    groups.push({ id: null, company: null, accounts: orphans });
  }
  return groups;
}
