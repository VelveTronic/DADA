/**
 * Deciding whether a `head: true` count actually came back.
 *
 * The staff shell reads its three backlog figures with
 * `select("id", { count: "exact", head: true })` — no rows, only the
 * `Content-Range` header — and the sidebar draws an em dash for any of them
 * that failed (see `ShellCounts`). Getting THAT branch right is the whole job
 * of this module, because the alternative is a nav that says "0 orders to
 * confirm" to a staff member whose read never happened.
 *
 * supabase-js does not throw for a query that did not work, and — this is the
 * part that is easy to get wrong — it does not always fill `error` either.
 * Two shapes come back from postgrest-js 2.112.3 with `error: null` and a
 * `count` of `null`:
 *
 * - `if (countHeader && contentRange && contentRange.length > 1) count = …`
 *   (`dist/index.mjs:468`): no `Content-Range` header on the response, no
 *   count. A proxy or a CDN that strips or rewrites that header leaves the
 *   result otherwise indistinguishable from a healthy one.
 * - `if (res.status === 404 && body === "") { status = 204; … }`
 *   (`dist/index.mjs:497-499`): a 404 with an empty body — which is what a HEAD
 *   request gets, since a HEAD response has no body to carry the error JSON —
 *   is rewritten to `204 No Content` and never becomes an `error` at all.
 *
 * So `error` alone is not the test. The test is the count itself: a successful
 * `head: true` + `count: "exact"` response ALWAYS carries its figure, so
 * `count === null` means the figure did not arrive, whatever `error` says.
 *
 * Pure on purpose — it imports no client and issues no request, so the
 * decision is pinned by the table beside it rather than by pointing a browser
 * at a broken database. The caller keeps the logging.
 */

/** As much of a `head: true` count response as `readCount` reads. */
export type CountResult = {
  /** From `Content-Range`. `null` whenever the header did not arrive. */
  count: number | null;
  /** postgrest-js's error object, or `null` — including on the two shapes above. */
  error: object | null;
  /** The response status, for the caller's log line. */
  status: number;
};

/**
 * The figure, or `null` when the read cannot be trusted to have one.
 *
 * `0` is a real answer and travels through as `0`; only a missing count is
 * `null`. A caller that wants to say something about the failure should look
 * at `error` (set = a refusal or a network fault, unset = the header was not
 * there) rather than re-deriving the decision.
 */
export function readCount(result: CountResult): number | null {
  if (result.error) return null;
  return result.count;
}
