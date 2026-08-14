import "server-only";
import { createServerSupabase } from "@/lib/supabase/server";

/**
 * WHO is making this request, server-side, validated against Supabase — the one
 * fact the client is never trusted for. `auth.getUser()` re-validates the token
 * on every call, so a session revoked elsewhere is refused here even though the
 * proxy only refreshes cookies.
 *
 * Deliberately total: an error, an expired token or no cookie at all is `null`,
 * never a throw. A helper that could throw would be able to fail an order that
 * was otherwise fine.
 *
 * Both failure paths log, because `null` is otherwise indistinguishable from a
 * signed-out visitor — and a misconfigured URL/key would silently sign the whole
 * portal out rather than fail loudly. A plain "no session" is NOT an error here:
 * `getUser()` reports that as `error` too, so the log is noisy by design and
 * meant to be read alongside the request, not alerted on.
 *
 * Returns the authenticated user or null. Never throws.
 */
export async function getSessionUser() {
  try {
    const supabase = await createServerSupabase();
    const { data, error } = await supabase.auth.getUser();
    if (error) {
      console.error("getSessionUser:", error);
      return null;
    }
    return data.user ?? null;
  } catch (e) {
    console.error("getSessionUser:", e);
    return null;
  }
}
