import "server-only";
import { getSessionUser } from "@/lib/auth/session";
import { createServerSupabase } from "@/lib/supabase/server";

/**
 * The staff gate a SERVER ACTION enters through: verifies an active
 * `staff_users` row for the caller, and throws if there is not one.
 *
 * **Why it exists at all, next to three different database gates.** A Server
 * Action is its own POST endpoint. It is reachable by anyone who knows the
 * action id, without ever rendering the page that draws its button, so the
 * page's `requireStaff` is not a gate on the write — it is a gate on the
 * screen. Each of this app's three staff write mechanisms answers a stranger
 * differently, and this helper is what makes all three answer EARLY and the
 * same way:
 *
 *  - `staff-products.ts` writes with the SERVICE-ROLE client, because the six
 *    price columns are revoked from authenticated outright. There is no RLS
 *    left underneath, so here this check is the only gate and it must fail
 *    CLOSED — a throw, not the silent return the favourites action can afford.
 *  - `staff-orders.ts` calls SECURITY DEFINER RPCs that raise STAFF_ONLY on
 *    `private.is_staff()` themselves. This is the suspenders: the belt holds
 *    without it, one round trip later.
 *  - `staff-categories.ts` writes `public.categories` on the caller's OWN
 *    session under RLS. If this were removed, the database would still refuse
 *    every statement in that file.
 *
 * So: the kinder half everywhere, and the whole gate in one place.
 *
 * **It lives beside `guards.ts` rather than in it, deliberately.** The guards
 * are the PAGE's gates and they answer by redirecting somebody to a screen they
 * may see; an action has no page to send anybody back to, so it throws. Keeping
 * the two apart also keeps the security-audited `guards.ts` untouched by a
 * refactor that only moved three identical copies of this function together.
 */
export async function assertStaff() {
  const user = await getSessionUser();
  if (!user) throw new Error("UNAUTHENTICATED");

  const supabase = await createServerSupabase();
  const { data: staffUser, error } = await supabase
    .from("staff_users")
    .select("id, is_active")
    .eq("id", user.id)
    .maybeSingle();
  if (error) console.error("assertStaff:", error);
  if (!staffUser?.is_active) throw new Error("NOT_STAFF");
}
