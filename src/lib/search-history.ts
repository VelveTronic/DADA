/**
 * The search screen's recent-term list, as it is stored on the customer's own
 * phone. Pure, no I/O: the browser leaf reads and writes `localStorage`, this
 * module owns what a stored value MEANS and what pressing 搜索 does to the list.
 *
 * It is deliberately local and not a table. What a restaurant typed is a
 * convenience for the next visit to this one screen — it is not order data, it
 * is not worth a round trip on a page whose whole job is to answer fast, and
 * keeping it out of the database keeps it out of everything that has to be
 * backed up, RLS'd and explained.
 */

/** Namespaced, because a browser origin is shared by every screen of the app. */
export const SEARCH_HISTORY_KEY = "dada.search.history";

/**
 * Ten terms, which is roughly what the chip wrap can hold on a 390px phone
 * before it starts pushing the results off the screen it is supposed to be
 * introducing.
 */
export const SEARCH_HISTORY_MAX = 10;

/**
 * A raw `localStorage` value → the list to render.
 *
 * Everything about the input is untrusted: it is a string on a machine we do not
 * own, it may have been written by an older build, by another tab, or by hand in
 * a devtools console. So anything that is not a JSON array of strings answers
 * with an EMPTY list rather than throwing — a corrupt key must cost the customer
 * their history, never the search page.
 *
 * The cap is applied on the way IN as well as on the way out (`pushHistory`),
 * for the same reason: the ceiling has to hold for a value this build did not
 * write.
 */
export function parseHistory(raw: string | null): string[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((entry): entry is string => typeof entry === "string")
    .slice(0, SEARCH_HISTORY_MAX);
}

/**
 * The list after a search for `q`: most recent first, no duplicates, capped.
 *
 * Move-to-front rather than append, because the list is read as "what I look for
 * on this phone" — a term searched again is the freshest thing in it, and a
 * chip that never moves is a chip that ages off the end while still being used.
 *
 * Dedupe is an EXACT match of the trimmed term, which is what the chips link
 * with: near-misses ("可乐" / "可乐 330") are genuinely different searches here.
 *
 * **Nothing to change means the SAME ARRAY back**, so a caller can tell "no
 * write is needed" by identity. Two shapes reach it:
 *
 * - a blank `q` — the bare `/buscar` landing, where there is no search to
 *   remember;
 * - a term that is already at the front of a list this function has nothing
 *   else to do to — no copy of it further down to promote, nothing over the
 *   cap to drop. That is re-entering a search already at the top of the
 *   history: pressing the first chip, reloading a result page, or React
 *   StrictMode running the browser leaf's effect a second time.
 *
 * The leaf writes only when the array it gets back is a different one
 * (`search-history.tsx`), so both shapes leave `localStorage` untouched.
 */
export function pushHistory(list: string[], q: string): string[] {
  const term = q.trim();
  if (!term) return list;
  // Already the freshest term AND the list is otherwise exactly what this
  // function would have produced: no duplicate below the front to fold away
  // (`indexOf` from 1), nothing past the cap to cut. Anything else falls
  // through and gets rebuilt.
  if (
    list[0] === term &&
    list.indexOf(term, 1) === -1 &&
    list.length <= SEARCH_HISTORY_MAX
  ) {
    return list;
  }
  return [term, ...list.filter((entry) => entry !== term)].slice(
    0,
    SEARCH_HISTORY_MAX,
  );
}
