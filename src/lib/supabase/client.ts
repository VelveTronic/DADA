"use client";

import { createBrowserClient } from "@supabase/ssr";
import type { Database } from "./database.types";

/**
 * Supabase client for Client Components. `createBrowserClient` stores the
 * session in `sb-*` cookies (not localStorage), which is what lets the proxy
 * and the server clients see the same session.
 */
export function createClient() {
  return createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
