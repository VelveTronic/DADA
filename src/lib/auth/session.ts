import "server-only";
import { cache } from "react";
import { createServerSupabase } from "@/lib/supabase/server";

/**
 * WHO is making this request, server-side, validated against Supabase — the one
 * fact the client is never trusted for. `auth.getClaims()` validates the JWT
 * signature against the project's published keys on every call.
 *
 * Deliberately total: an error, an expired token or no cookie at all is `null`,
 * never a throw. A helper that could throw would be able to fail an order that
 * was otherwise fine.
 *
 * A missing session is normal and deliberately quiet. Unexpected Auth or
 * configuration failures are logged so an outage cannot masquerade as logout.
 * React cache deduplicates the check within one render pass.
 *
 * `email` rides along on the same validated claim set for the two places that
 * need it: 我的信息 prints it, and the password change re-authenticates with it.
 * That second use is the reason it comes from HERE and never from a form field —
 * `signInWithPassword` against an address the browser supplied would let a
 * crafted POST test somebody else's password. It is `null` for any session whose
 * token carries no email claim, and the callers refuse rather than guess.
 */
export const getSessionUser = cache(async () => {
  try {
    const supabase = await createServerSupabase();
    const { data, error } = await supabase.auth.getClaims();
    if (error) {
      if (error.name !== "AuthSessionMissingError") {
        console.error("getSessionUser:", error);
      }
      return null;
    }
    const id = data?.claims?.sub;
    if (typeof id !== "string") return null;
    const email = data?.claims?.email;
    return { id, email: typeof email === "string" ? email : null };
  } catch (e) {
    console.error("getSessionUser:", e);
    return null;
  }
});
