"use client";

import { createBrowserClient } from "@supabase/ssr";
import type { Database } from "./database.types";
import { getSupabasePublicEnv } from "./env";

/**
 * Supabase client for Client Components. `createBrowserClient` stores the
 * session in `sb-*` cookies (not localStorage), which is what lets the proxy
 * and the server clients see the same session.
 */
export function createClient() {
  const { url, key } = getSupabasePublicEnv();
  return createBrowserClient<Database>(url, key);
}
