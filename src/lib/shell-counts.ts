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
 * So `error` alone is not the test. A set `error` still disqualifies on its
 * own — a refusal is a refusal even when a count arrives beside it — but the
 * figure is only trusted when it actually came: a successful `head: true` +
 * `count: "exact"` response ALWAYS carries one, so `count === null` fails the
 * read whichever way `error` fell.
 *
 * `readCount` is pure on purpose — it imports no client and issues no request,
 * so the decision is pinned by the table beside it rather than by pointing a
 * browser at a broken database. `readLoggedCount` below is that same decision
 * with the log line the readers print, kept here because four of them were
 * writing the identical one.
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

/**
 * `readCount`, plus the line the server log gets when the figure did not come:
 * `<scope> <name> count (status <n>): <error>`.
 *
 * This is the logging half, the one every reader used to write for itself, and
 * the reason it is worth a function of its own is that it has to print BOTH
 * failure shapes. A `head: true` request that fails quietly is the easiest
 * kind to miss: a HEAD response has no body, so postgrest-js has no error JSON
 * to parse and `error.message` would be `""` even when it does fill one in. So
 * the status is printed too, and a result that failed with no error at all is
 * NAMED as what it is rather than logged as a bare `null`.
 *
 * `scope` says which reader is speaking ("staff users"), `name` which figure
 * ("active companies"). The shell and the staff home still inline copies that
 * are byte-identical but for that first string, and the order queue's takes a
 * typed `QueueTab` in place of `name` around the same body and emitted line;
 * folding them in is a change of its own, being three more renders to check.
 *
 * The return travels exactly as `readCount`'s does: `0` is a real answer, and
 * `null` is drawn as an em dash and never as 0.
 */
export function readLoggedCount(
  scope: string,
  name: string,
  result: CountResult,
): number | null {
  const value = readCount(result);
  if (value === null) {
    console.error(
      `${scope} ${name} count (status ${result.status}):`,
      result.error ?? "no content-range on the response",
    );
  }
  return value;
}
