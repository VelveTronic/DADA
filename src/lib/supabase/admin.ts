import "server-only";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./database.types";

/**
 * Service-role client: bypasses RLS entirely. Server-only module — importing it
 * from client code is a build error via the `server-only` package.
 *
 * The key is read inside the factory, never at module scope, so importing this
 * file (e.g. from a route that only conditionally needs admin access) cannot
 * fail a build in an environment where `SUPABASE_SERVICE_ROLE_KEY` is absent.
 */
export function createAdminClient() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
  return createSupabaseClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    key,
    {
      auth: { persistSession: false, autoRefreshToken: false },
    },
  );
}
