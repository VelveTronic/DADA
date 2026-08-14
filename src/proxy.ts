// Next 16 renamed the `middleware` file convention to `proxy`
// (node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md).
// The handler factory is still imported from `next-intl/middleware`.
import { createServerClient } from "@supabase/ssr";
import createIntlMiddleware from "next-intl/middleware";
import type { NextRequest, NextResponse } from "next/server";
import { routing } from "@/i18n/routing";
import type { Database } from "@/lib/supabase/database.types";

const intl = createIntlMiddleware(routing);

/**
 * Two jobs in one file, because Next allows exactly one proxy per app:
 * locale routing (`/` → `/zh`, unprefixed paths → `/<locale>/…`) and Supabase
 * session refresh.
 *
 * **Why the session refresh has to live here.** `@supabase/ssr` refreshes an
 * expired access token by WRITING cookies, and a Server Component cannot set
 * cookies — which is why `src/lib/supabase/server.ts` swallows the write in a
 * try/catch. The library is explicit that this is the proxy's job: "Session
 * refresh happens in the middleware" (`node_modules/@supabase/ssr/docs/design.md`).
 *
 * **The intl response is the response.** next-intl answers most requests with a
 * rewrite and some with a redirect (`/` → `/zh`). Either way it is a response
 * object Supabase did not create, so the refreshed cookies must be written onto
 * THAT object — hence `intl(request)` runs first and `setAll` targets it.
 * next-intl sanctions being wrapped like this: its middleware docs describe
 * modifying the response it produces (next-intl.dev/docs/routing/middleware,
 * §Composing other middlewares).
 *
 * **The anonymous fast path.** Without an `sb-*` cookie there is no session to
 * refresh, so the Supabase client is never constructed and the response is
 * byte-identical to what an intl-only proxy would return — no `Set-Cookie`, no
 * cache-busting headers. Missing env vars take the same path: auth
 * configuration must never be able to take the portal down.
 */
export default async function proxy(request: NextRequest): Promise<NextResponse> {
  const response = intl(request);

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseKey || !hasAuthCookie(request)) return response;

  const supabase = createServerClient<Database>(supabaseUrl, supabaseKey, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (cookiesToSet, headers) => {
        cookiesToSet.forEach(({ name, value, options }) =>
          response.cookies.set(name, value, options),
        );
        // The library's own cache-control set (`private, no-cache, no-store`,
        // `Expires: 0`, `Pragma: no-cache`): a response carrying someone's auth
        // cookie must never be cached. Only ever written when `setAll` fires,
        // i.e. when the session actually changed.
        Object.entries(headers).forEach(([name, value]) =>
          response.headers.set(name, value),
        );
      },
    },
  });

  // Nothing between `createServerClient` and this call: it is what triggers the
  // refresh, and the cookies it produces have to be written before the response
  // is committed (`CookieMethodsServer.setAll` docblock).
  //
  // `getSession()`, not `getUser()`: both run the same `__loadSession()` — read
  // the cookies, and if the access token is inside its expiry margin, POST
  // `/token?grant_type=refresh_token` and save — which IS the refresh. `getUser()`
  // is that plus an unconditional `GET /auth/v1/user` round trip to validate the
  // token, and the result is discarded here either way. This proxy refreshes, it
  // does not authorise: every authorisation decision re-asks with its own
  // validated `auth.getUser()` via `src/lib/auth/session.ts`, so a session
  // revoked elsewhere is still refused there, on the same request.
  await supabase.auth.getSession();

  return response;
}

/**
 * Supabase stores the session in `sb-<project-ref>-auth-token` (plus `.0`/`.1`
 * chunks when it is long, and `…-code-verifier` mid-PKCE) — every one of them
 * `sb-` prefixed. No such cookie ⇒ no session ⇒ nothing to refresh.
 */
function hasAuthCookie(request: NextRequest): boolean {
  return request.cookies.getAll().some(({ name }) => name.startsWith("sb-"));
}

export const config = {
  matcher: ["/((?!api|_next|_vercel|.*\\..*).*)"],
};
