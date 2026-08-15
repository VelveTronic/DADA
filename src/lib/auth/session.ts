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
    return typeof id === "string" ? { id } : null;
  } catch (e) {
    console.error("getSessionUser:", e);
    return null;
  }
});
