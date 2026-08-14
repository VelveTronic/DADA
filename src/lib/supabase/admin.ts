import "server-only";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./database.types";

/**
 * Service-role client: bypasses RLS entirely. Server-only module — importing it
 * from client code is a build error via the `server-only` package.
 *
 * The missing-env THROW lives inside the factory rather than at module scope:
 * a module-scope throw fires on import, so every route that merely imports this
 * file — even on a path that never needs admin access — would fail to build or
 * boot wherever `SUPABASE_SERVICE_ROLE_KEY` is absent (it deliberately is, in
 * this repo's `.env.local`). Here it fires only on an actual call.
 */
export function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "Supabase admin client requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY",
    );
  }
  return createSupabaseClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
