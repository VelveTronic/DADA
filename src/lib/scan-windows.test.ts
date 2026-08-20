import { describe, expect, it } from "vitest";
import {
  MAX_SCAN_WINDOWS,
  SCAN_WINDOW,
  scanRange,
  scanTruncated,
  scanWindowCount,
} from "./scan-windows";

describe("SCAN_WINDOW", () => {
  /**
   * The whole point of the module: the window is PostgREST's `max_rows`
   * (`supabase/config.toml:18`). If this ever drifts above the server setting
   * the windows overlap the cap and the scan silently loses rows again.
   */
  it("is PostgREST's max_rows", () => {
    expect(SCAN_WINDOW).toBe(1000);
  });
});

describe("scanRange", () => {
  it.each([
    [0, 0, 999],
    [1, 1000, 1999],
    [2, 2000, 2999],
    [MAX_SCAN_WINDOWS - 1, 9000, 9999],
  ])("window %i covers %i-%i", (index, from, to) => {
    expect(scanRange(index)).toEqual({ from, to });
  });

  /** Disjoint and gapless: window n starts exactly where n-1 stopped. */
  it("tiles the table with no gap and no overlap", () => {
    for (let index = 1; index < MAX_SCAN_WINDOWS; index++) {
      expect(scanRange(index).from).toBe(scanRange(index - 1).to + 1);
    }
  });

  it("takes a smaller window for a test that does not want 1000 rows", () => {
    expect(scanRange(3, 10)).toEqual({ from: 30, to: 39 });
  });
});

describe("scanWindowCount", () => {
  it.each([
    // An empty table still cost the one request that discovered it was empty.
    [0, 1],
    [1, 1],
    // Exactly one full window — the cap is not a reason to ask for a second.
    [1000, 1],
    [1001, 2],
    // Today's products table.
    [2971, 3],
    [3000, 3],
    [3001, 4],
    // The ceiling, and past it.
    [10_000, 10],
    [10_001, 10],
    [999_999, 10],
  ])("%i rows → %i windows", (total, windows) => {
    expect(scanWindowCount(total)).toBe(windows);
  });

  /** A count that never arrived (a failed first window) must not loop. */
  it.each([Number.NaN, Number.POSITIVE_INFINITY, -5])(
    "%o → one window",
    (total) => {
      expect(scanWindowCount(total)).toBe(1);
    },
  );

  it("honours a caller's own size and ceiling", () => {
    expect(scanWindowCount(25, 10)).toBe(3);
    expect(scanWindowCount(25, 10, 2)).toBe(2);
  });
});

describe("scanTruncated", () => {
  it.each([
    [0, false],
    [2971, false],
    // The ceiling reaches exactly 10,000 rows, so 10,000 is whole.
    [10_000, false],
    [10_001, true],
    [40_000, true],
  ])("%i rows → truncated %o", (total, truncated) => {
    expect(scanTruncated(total)).toBe(truncated);
  });

  /**
   * The plan is what is checked, not the rows that came back — a product
   * inserted between two windows must not be reported as an overrun.
   */
  it("agrees with the plan it is the counterpart of", () => {
    for (const total of [0, 1, 999, 1000, 1001, 2971, 9999, 10_000, 10_001]) {
      expect(scanTruncated(total)).toBe(
        scanWindowCount(total) * SCAN_WINDOW < total,
      );
    }
  });

  it("honours a caller's own size and ceiling", () => {
    expect(scanTruncated(20, 10, 2)).toBe(false);
    expect(scanTruncated(21, 10, 2)).toBe(true);
  });
});
