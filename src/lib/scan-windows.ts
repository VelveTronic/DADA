/**
 * Reading a table that is longer than one PostgREST response.
 *
 * PostgREST caps every response at `max_rows` — 1000 in this project
 * (`supabase/config.toml:18`, and 1000 is the cloud default the hosted project
 * runs on too) — and it applies that cap whether or not the request asks for a
 * limit of its own. So `.range(0, 4999)` on a 2,971-row table does NOT fail and
 * does not return 2,971 rows: it returns the first 1000 with a `Content-Range`
 * of `0-999/2971`. A caller that trusts the array it got back silently sees a
 * third of the table, which is the shape of bug that reads on screen as "this
 * category has no products".
 *
 * A scan that must see the whole table therefore walks it in windows of the
 * cap, ordered by a stable column so the windows are disjoint, and stops once
 * it has covered the exact `count` the FIRST window reported. This file is the
 * arithmetic of that walk and nothing else — no client, no rows, no I/O — so
 * the bounds and the stopping rule are pinned by the test beside it rather than
 * by reading a server log and hoping.
 */

/**
 * One window, in rows. Equal to `max_rows`, because a larger number is silently
 * cut to it and a smaller one just buys more round trips.
 */
export const SCAN_WINDOW = 1000;

/**
 * The hard ceiling on one scan, in windows.
 *
 * Ten windows is 10,000 rows — more than three times the 2,971 products the
 * freepos import loaded — so reaching it does not mean "the catalogue grew a
 * bit". It means the table has outgrown what an in-memory tally on a page
 * render should be doing at all, and the honest answer then is to log the
 * overrun and draw what was read, not to keep issuing requests until the page
 * times out.
 */
export const MAX_SCAN_WINDOWS = 10;

/** The inclusive `.range(from, to)` bounds of window `index`, counting from 0. */
export function scanRange(
  index: number,
  size: number = SCAN_WINDOW,
): { from: number; to: number } {
  const from = index * size;
  return { from, to: from + size - 1 };
}

/**
 * How many windows a scan of `total` rows runs.
 *
 * Never zero, and never fewer than one: the first window is what LEARNS the
 * total, so by the time this is asked it has already been issued — an empty
 * table still cost one request. Capped at `max`; a `total` past what `max`
 * windows can reach is the overrun `scanTruncated` reports.
 */
export function scanWindowCount(
  total: number,
  size: number = SCAN_WINDOW,
  max: number = MAX_SCAN_WINDOWS,
): number {
  if (!Number.isFinite(total) || total <= size) return 1;
  return Math.min(Math.ceil(total / size), max);
}

/**
 * Whether `total` rows are more than the ceiling can reach.
 *
 * The counterpart of `scanWindowCount`, and deliberately NOT "did I read fewer
 * rows than the count said": rows inserted or deleted while the scan is walking
 * move that number in both directions, and a page must not log a truncation
 * because somebody added a product mid-render. Only the plan being capped is a
 * real overrun.
 */
export function scanTruncated(
  total: number,
  size: number = SCAN_WINDOW,
  max: number = MAX_SCAN_WINDOWS,
): boolean {
  return Number.isFinite(total) && total > size * max;
}
