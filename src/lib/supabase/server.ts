import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import type { Database } from "./database.types";
import { getSupabasePublicEnv } from "./env";

/**
 * Supabase client for Server Components, Server Actions and route handlers.
 * Requests made through it carry the caller's session, so RLS applies.
 *
 * A Server Component cannot write cookies, so `setAll` swallows the throw: an
 * expired token is refreshed by `src/proxy.ts` instead, which is the pattern
 * `@supabase/ssr` documents ("Session refresh happens in the middleware",
 * `node_modules/@supabase/ssr/docs/design.md`).
 */
export async function createServerSupabase() {
  const cookieStore = await cookies();
  const { url, key } = getSupabasePublicEnv();
  return createServerClient<Database>(url, key, {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (cookiesToSet) => {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // called from a Server Component — safe to ignore, proxy refreshes sessions
          }
        },
      },
    },
  );
}
