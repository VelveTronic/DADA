import { describe, expect, it } from "vitest";
import {
  SEARCH_HISTORY_MAX,
  parseHistory,
  pushHistory,
} from "./search-history";

/**
 * Two rules, and both of them are about a value this build did not write.
 *
 * `parseHistory` reads a string off the customer's own machine — an older
 * build's shape, another tab's write, a hand-edited devtools value — so every
 * malformed case has to answer with an empty list. A throw here is a search
 * page that renders nothing at all, on the one screen that has to answer.
 *
 * `pushHistory` is the list's whole edit surface: move-to-front, deduped and
 * capped, and idempotent for the same term — which is what lets the browser leaf
 * run it inside an effect that React StrictMode invokes twice.
 */

describe("parseHistory", () => {
  const cases: Array<{ name: string; raw: string | null; expected: string[] }> = [
    { name: "no key at all", raw: null, expected: [] },
    { name: "an empty value", raw: "", expected: [] },
    { name: "junk that is not JSON", raw: "可乐", expected: [] },
    { name: "a truncated array", raw: '["可乐"', expected: [] },
    { name: "JSON that is not an array — an object", raw: '{"0":"可乐"}', expected: [] },
    { name: "JSON that is not an array — a string", raw: '"可乐"', expected: [] },
    { name: "JSON that is not an array — a number", raw: "7", expected: [] },
    { name: "JSON null", raw: "null", expected: [] },
    { name: "an empty array is a legal empty history", raw: "[]", expected: [] },
    { name: "the shape this module writes", raw: '["可乐","白菜"]', expected: ["可乐", "白菜"] },
    {
      name: "non-string entries are dropped, the strings around them survive",
      raw: '["可乐",7,null,{"k":"x"},["白菜"],"酱油"]',
      expected: ["可乐", "酱油"],
    },
  ];

  for (const { name, raw, expected } of cases) {
    it(name, () => {
      expect(parseHistory(raw)).toEqual(expected);
    });
  }

  /** A longer list can only come from outside this build; the ceiling still holds. */
  it("caps a stored list that is longer than the maximum", () => {
    const stored = JSON.stringify(
      Array.from({ length: SEARCH_HISTORY_MAX + 5 }, (_, i) => `t${i}`),
    );
    expect(parseHistory(stored)).toHaveLength(SEARCH_HISTORY_MAX);
    expect(parseHistory(stored)[0]).toBe("t0");
  });
});

describe("pushHistory", () => {
  it("puts a new term at the front", () => {
    expect(pushHistory(["白菜"], "可乐")).toEqual(["可乐", "白菜"]);
  });

  it("starts a list from nothing", () => {
    expect(pushHistory([], "可乐")).toEqual(["可乐"]);
  });

  /** THE dedupe case: searching something again promotes it, it does not repeat it. */
  it("moves a term already in the list to the front instead of duplicating it", () => {
    expect(pushHistory(["白菜", "可乐", "酱油"], "可乐")).toEqual([
      "可乐",
      "白菜",
      "酱油",
    ]);
  });

  /**
   * The property the browser leaf leans on: the effect that writes this list is
   * keyed on `?q`, and React StrictMode invokes it twice in development.
   */
  it("is idempotent for the same term", () => {
    const once = pushHistory(["白菜"], "可乐");
    expect(pushHistory(once, "可乐")).toEqual(once);
  });

  it("trims the term it stores", () => {
    expect(pushHistory([], "  可乐  ")).toEqual(["可乐"]);
  });

  it("dedupes against the trimmed term, not the raw one", () => {
    expect(pushHistory(["可乐"], " 可乐 ")).toEqual(["可乐"]);
  });

  const noop: Array<{ name: string; q: string }> = [
    { name: "an empty query", q: "" },
    { name: "spaces", q: "   " },
    { name: "a tab and a newline", q: "\t\n" },
  ];

  for (const { name, q } of noop) {
    it(`leaves the list untouched for ${name}`, () => {
      const list = ["可乐", "白菜"];
      // Identity, not equality: a bare `/buscar` must not rewrite storage.
      expect(pushHistory(list, q)).toBe(list);
    });
  }

  it("caps the list at the maximum, dropping the oldest term", () => {
    const full = Array.from({ length: SEARCH_HISTORY_MAX }, (_, i) => `t${i}`);
    const next = pushHistory(full, "可乐");
    expect(next).toHaveLength(SEARCH_HISTORY_MAX);
    expect(next[0]).toBe("可乐");
    expect(next).not.toContain(`t${SEARCH_HISTORY_MAX - 1}`);
  });

  it("does not mutate the list it was given", () => {
    const list = ["白菜"];
    pushHistory(list, "可乐");
    expect(list).toEqual(["白菜"]);
  });
});
