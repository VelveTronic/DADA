// Next 16 renamed the `middleware` file convention to `proxy`
// (node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md).
// The handler factory is still imported from `next-intl/middleware`.
import { createServerClient, type SetAllCookies } from "@supabase/ssr";
import createIntlMiddleware from "next-intl/middleware";
import type { NextRequest, NextResponse } from "next/server";
import { routing } from "@/i18n/routing";
import type { Database } from "@/lib/supabase/database.types";

const intl = createIntlMiddleware(routing);

/** `{name, value, options}` exactly as `@supabase/ssr` hands it to `setAll`. */
type PendingCookie = Parameters<SetAllCookies>[0][number];

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
 * **Why the refresh runs BEFORE intl.** The fresh token has to reach two
 * different places, and only one of them is the browser:
 *
 * ```text
 * refresh  → request.cookies.set(…)   → the RSC render downstream reads the NEW token
 *          → pending[]                → the browser gets it via Set-Cookie
 * ```
 *
 * next-intl decides the routing by snapshotting the request it is handed, so a
 * response it produced before the refresh carries the OLD cookies downstream.
 * The render would then hit `src/lib/auth/session.ts` with an expired token and
 * refresh a second time — outside Supabase's brief refresh-token reuse window
 * that second refresh fails against an already-rotated token, which is the
 * classic random-logout bug. Writing onto `request.cookies` first and calling
 * `intl(request)` after is what closes it, and it also satisfies both halves of
 * the `@supabase/ssr` contract: `getAll` sees what `setAll` wrote (both go
 * through `request.cookies`), and the cookies land on the request AND the
 * response.
 *
 * The response is still intl's, unmodified except for those cookies and their
 * cache headers — next-intl sanctions exactly that ("modify the response",
 * next-intl.dev/docs/routing/middleware, §Composing other middlewares) and it is
 * what keeps a redirect (`/` → `/zh`) intact.
 *
 * **The anonymous fast path.** A request with no `sb-*` cookie has no session to
 * refresh, so it skips the Supabase client, the token round trip and the cookie
 * bookkeeping entirely — proxy work drops to what intl alone costs. The env
 * guard rides along on the same branch so a missing key degrades to plain locale
 * routing instead of throwing out of `createServerClient` on every route,
 * including the 404 document; it is not a claim that the portal works without
 * them (it does not — the catalog is login-gated and the client factories
 * hard-assert both vars).
 */
export default async function proxy(request: NextRequest): Promise<NextResponse> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey =
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseKey || !hasAuthCookie(request)) {
    return intl(request);
  }

  // What the refresh produced, held until intl has made a response to put it on.
  const pendingCookies: PendingCookie[] = [];
  const pendingHeaders: Record<string, string> = {};

  const supabase = createServerClient<Database>(supabaseUrl, supabaseKey, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (cookiesToSet, headers) => {
        for (const cookie of cookiesToSet) {
          // Onto the request: this is what `getAll` re-reads and what intl
          // snapshots below, so the render downstream sees the fresh token.
          request.cookies.set(cookie.name, cookie.value);
          pendingCookies.push(cookie);
        }
        // The library's own cache-control set (`private, no-cache, no-store`,
        // `Expires: 0`, `Pragma: no-cache`): a response carrying someone's auth
        // cookie must never be cached by a CDN or reverse proxy.
        Object.assign(pendingHeaders, headers);
      },
    },
  });

  // Nothing between `createServerClient` and this call: it is what triggers the
  // refresh, and the cookies it produces have to exist before any response is
  // built (`CookieMethodsServer.setAll` docblock).
  //
  // Supabase's SSR guidance requires getClaims(): unlike getSession(), it
  // validates the JWT signature and still performs the required cookie refresh.
  // Authorization remains in the data-access guards, close to each data read.
  await supabase.auth.getClaims();

  const response = intl(request);

  // Same-name cookies overwrite in `ResponseCookies`, so applying in the order
  // `setAll` produced them leaves the last write standing.
  for (const { name, value, options } of pendingCookies) {
    response.cookies.set(name, value, options);
  }
  if (pendingCookies.length > 0) {
    for (const [name, value] of Object.entries(pendingHeaders)) {
      response.headers.set(name, value);
    }
  }
  return response;
}

/**
 * Supabase stores the session in `sb-<project-ref>-auth-token` (plus `.0`/`.1`
 * chunks when it is long, and `…-code-verifier` mid-PKCE) — every one of them
 * `sb-` prefixed. No such cookie ⇒ no session ⇒ nothing to refresh.
 */
export function hasAuthCookie(request: NextRequest): boolean {
  return request.cookies.getAll().some(({ name }) => name.startsWith("sb-"));
}

export const config = {
  // Everything except Next's own infrastructure and static assets. The excluded
  // segments are anchored (`api/…`, not `apiary`) and assets are excluded by
  // extension rather than by "contains a dot", so a real page whose slug happens
  // to contain one is still localized instead of silently escaping the proxy.
  matcher: [
    "/((?!(?:api|_next|_vercel)(?:/|$)|.*\\.(?:ico|png|jpg|jpeg|svg|gif|webp|css|js|map|txt|xml|json|woff2?)$).*)",
  ],
};
