import { afterEach, describe, expect, it, vi } from "vitest";
import { type CountResult, readCount, readLoggedCount } from "./shell-counts";

/** postgrest-js's error object, as much of it as `readCount` ever looks at. */
const REFUSAL = {
  message: "permission denied for table orders",
  details: "",
  hint: "",
  code: "42501",
};

/**
 * The two responses that come back looking healthy — `error` unset — and still
 * carry no figure. See the module note for where postgrest-js produces each.
 */
const SILENT: CountResult[] = [
  // A HEAD 404: empty body, so there is no error JSON to parse, and
  // postgrest-js rewrites the status to 204 rather than filling `error`.
  { count: null, error: null, status: 204 },
  // A 200 whose `Content-Range` did not survive the trip.
  { count: null, error: null, status: 200 },
];

describe("readCount", () => {
  it.each<[string, CountResult, number | null]>([
    ["a policy refusal", { count: null, error: REFUSAL, status: 403 }, null],
    [
      "an error that arrived with a count beside it",
      { count: 7, error: REFUSAL, status: 500 },
      null,
    ],
    ["a HEAD 404 rewritten to 204", SILENT[0], null],
    ["a 200 with the Content-Range stripped", SILENT[1], null],
    ["an empty table", { count: 0, error: null, status: 200 }, 0],
    ["a table with rows in it", { count: 42, error: null, status: 200 }, 42],
  ])("%s → %o", (_case, result, expected) => {
    expect(readCount(result)).toBe(expected);
  });

  /**
   * The regression this module was extracted for. The shell used to answer
   * `count ?? 0`, which turned both silent shapes into a confident zero — and
   * with `error` unset there was nothing to log and nothing to notice either.
   */
  it("does not let a countless response pass as 0", () => {
    for (const silent of SILENT) {
      expect(silent.error).toBeNull();
      expect(silent.count ?? 0).toBe(0);
      expect(readCount(silent)).toBeNull();
    }
  });
});

describe("readLoggedCount", () => {
  const logged = () => vi.spyOn(console, "error").mockImplementation(() => {});
  afterEach(() => vi.restoreAllMocks());

  it("returns what readCount returns, for every shape", () => {
    const cases: CountResult[] = [
      ...SILENT,
      { count: null, error: REFUSAL, status: 403 },
      { count: 7, error: REFUSAL, status: 500 },
      { count: 0, error: null, status: 200 },
      { count: 42, error: null, status: 200 },
    ];
    logged();
    for (const result of cases) {
      expect(readLoggedCount("staff users", "active companies", result)).toBe(
        readCount(result),
      );
    }
  });

  it("says nothing when the figure arrived", () => {
    const error = logged();
    expect(
      readLoggedCount("staff users", "active companies", {
        count: 0,
        error: null,
        status: 200,
      }),
    ).toBe(0);
    expect(error).not.toHaveBeenCalled();
  });

  /**
   * The line a reader is meant to find in the server log: WHO was reading, WHICH
   * figure, and the status — because the two silent shapes have no error to
   * print and would otherwise log as a bare `null` from an anonymous caller.
   */
  it.each<[string, CountResult, string, unknown]>([
    [
      "a policy refusal",
      { count: null, error: REFUSAL, status: 403 },
      "staff users active companies count (status 403):",
      REFUSAL,
    ],
    [
      "a HEAD 404 rewritten to 204",
      SILENT[0],
      "staff users active companies count (status 204):",
      "no content-range on the response",
    ],
    [
      "a 200 with the Content-Range stripped",
      SILENT[1],
      "staff users active companies count (status 200):",
      "no content-range on the response",
    ],
  ])("names %s in the log", (_case, result, line, detail) => {
    const error = logged();
    expect(readLoggedCount("staff users", "active companies", result)).toBeNull();
    expect(error).toHaveBeenCalledExactlyOnceWith(line, detail);
  });
});
