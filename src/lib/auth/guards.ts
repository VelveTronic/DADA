import "server-only";
import type { Locale } from "next-intl";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth/session";
import { perfStep } from "@/lib/perf";
import { createServerSupabase } from "@/lib/supabase/server";

/**
 * The two gates every page enters through, in two halves.
 *
 * **Why two halves.** A guard used to be one `await`: WHO is asking
 * (`getSessionUser`), then a profile row, and only then could the page start
 * the queries it exists to render. Three network round trips stacked nose to
 * tail, and the middle one blocked the other two for no reason a page could
 * see — the profile row and the catalogue's categories have nothing to say to
 * each other.
 *
 * So `begin…` does the part that has to come first (auth, and the client the
 * rest of the request rides on) and hands back the profile query ALREADY IN
 * FLIGHT; `finish…` is where the gate actually fires. Between the two a page
 * puts its own reads on the wire, and one `Promise.all` settles the lot:
 *
 * ```ts
 * const { supabase, pendingUser } = await beginCompanyUser(locale);
 * const [portalUser, categories] = await Promise.all([
 *   finishCompanyUser(pendingUser, locale),
 *   supabase.from("categories").select(…),
 * ]);
 * ```
 *
 * **What that does and does not relax.** The gate still fires before a single
 * byte is rendered — `finish…` redirects out of the `Promise.all`, so a
 * deactivated account never reaches the JSX — but the page's queries are now
 * allowed to be in flight WHILE it fires, and for a request that turns out to
 * be refused they run and their answers are thrown away. That is safe for the
 * queries the pages actually race here, and only for those: they all go through
 * `createServerSupabase`, so every one of them is answered under the caller's
 * own RLS. A page cannot learn anything this way that the same session could
 * not have read anyway; what the guard adds on top of RLS is the portal's
 * `is_active` pair, and nothing that is fetched under a failed one is ever
 * used. The SERVICE-ROLE client is the opposite case and is never raced —
 * `/staff/productos` and `/staff/usuarios` read rows RLS would refuse, so their
 * queries wait for `requireStaff` to have returned.
 *
 * `requireCompanyUser` / `requireStaff` are the two halves back to back, for
 * server actions and any page with nothing to overlap.
 */

type ServerSupabase = Awaited<ReturnType<typeof createServerSupabase>>;

/**
 * One string literal, never a concatenation: supabase-js types the row from the
 * literal, and a `select` built at runtime widens to `string` and loses it.
 *
 * The embedded company carries `codcli` for ONE screen: the identity card on
 * `/perfil` prints the ERP customer number under the restaurant's name. It rides
 * here rather than being read on that page because the join is already running
 * on every customer page and that row is already on the wire — one more integer
 * in a `select` that is fetching `name` from the very same row costs nothing,
 * while the page-level version could not overlap anything: it is keyed by
 * `company_id`, which is what THIS query goes to fetch, so it could only ever be
 * a third serialized round trip. `/direcciones` still reads its four address
 * columns on its own page; those are wide text columns for one screen, and the
 * trade there runs the other way.
 */
function companyUserQuery(supabase: ServerSupabase, userId: string) {
  return supabase
    .from("portal_users")
    .select(
      "id, company_id, display_name, locale, is_active, companies:company_id(id, codcli, name, tarcli, is_active)",
    )
    .eq("id", userId)
    .maybeSingle();
}

function staffUserQuery(supabase: ServerSupabase, userId: string) {
  return supabase
    .from("staff_users")
    .select("id, role, display_name, is_active")
    .eq("id", userId)
    .maybeSingle();
}

/** The profile query in flight, as a page holds it between the two halves. */
export type PendingCompanyUser = Promise<
  Awaited<ReturnType<typeof companyUserQuery>>
>;
export type PendingStaffUser = Promise<
  Awaited<ReturnType<typeof staffUserQuery>>
>;

/** Authenticated, with the restaurant's profile row already on the wire. */
export async function beginCompanyUser(locale: Locale) {
  const user = await perfStep("session", getSessionUser());
  if (!user) redirect(`/${locale}/login`);

  const supabase = await createServerSupabase();
  return {
    user,
    supabase,
    pendingUser: perfStep("profile", companyUserQuery(supabase, user.id)),
  };
}

/** The gate: an inactive account or restaurant never gets past this line. */
export async function finishCompanyUser(
  pendingUser: PendingCompanyUser,
  locale: Locale,
) {
  const { data: portalUser, error } = await pendingUser;

  if (error) console.error("requireCompanyUser:", error);
  if (!portalUser?.is_active || !portalUser.companies?.is_active) {
    redirect(`/${locale}/login?error=inactive`);
  }

  return portalUser;
}

/** Authenticated restaurant user with an active company. */
export async function requireCompanyUser(locale: Locale) {
  const { user, pendingUser } = await beginCompanyUser(locale);
  return { user, portalUser: await finishCompanyUser(pendingUser, locale) };
}

/** Authenticated, with the staff profile row already on the wire. */
export async function beginStaff(locale: Locale) {
  const user = await perfStep("session", getSessionUser());
  if (!user) redirect(`/${locale}/login`);

  const supabase = await createServerSupabase();
  return {
    user,
    supabase,
    pendingStaff: perfStep("profile", staffUserQuery(supabase, user.id)),
  };
}

/** The gate: a deactivated staff account never gets past this line. */
export async function finishStaff(
  pendingStaff: PendingStaffUser,
  locale: Locale,
) {
  const { data: staffUser, error } = await pendingStaff;

  if (error) console.error("requireStaff:", error);
  if (!staffUser?.is_active) {
    redirect(`/${locale}/login?error=inactive`);
  }

  return staffUser;
}

/** Authenticated active DADA staff member. */
export async function requireStaff(locale: Locale) {
  const { user, pendingStaff } = await beginStaff(locale);
  return { user, staffUser: await finishStaff(pendingStaff, locale) };
}
