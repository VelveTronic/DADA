import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SETTINGS,
  SETTINGS_DEFAULTS,
  SETTINGS_ERRORS,
  SETTING_KEYS,
  getSetting,
  isSettingKey,
  isSettingsResult,
  parseSettingInput,
  parseSettingKey,
  parseSettingValue,
  type SettingsClient,
} from "./settings";

/**
 * The whole point of these tests is the fail-open rule: `show_prices` decides
 * whether a restaurant sees any price at all, so the interesting cases are the
 * broken ones — a missing row, a jsonb value of the wrong shape, a SELECT that
 * errored — and every one of them has to answer `true`.
 *
 * The only case that may answer `false` is a row that literally holds the jsonb
 * boolean `false`, which is what the owner's toggle writes.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * A stand-in for the four chained calls `getSetting` makes. Typed through
 * `unknown` because reproducing PostgREST's builder types would test the mock
 * rather than the code.
 */
function fakeClient(outcome: { data: { value: unknown } | null; error: unknown }) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve(outcome),
        }),
      }),
    }),
  } as unknown as SettingsClient;
}

describe("parseSettingValue — show_prices", () => {
  const cases: Array<{ name: string; raw: unknown; expected: boolean }> = [
    { name: "a missing row (undefined) falls back to the default", raw: undefined, expected: true },
    { name: "a jsonb null falls back to the default", raw: null, expected: true },
    { name: 'the string "false" is NOT false', raw: "false", expected: true },
    { name: 'the string "true" is not a boolean either', raw: "true", expected: true },
    { name: "the number 0 is not false", raw: 0, expected: true },
    { name: "the number 1 is not true, it is malformed", raw: 1, expected: true },
    { name: "an object is malformed", raw: { show: false }, expected: true },
    { name: "an array is malformed", raw: [false], expected: true },
    { name: "an empty string is malformed", raw: "", expected: true },
    { name: "the boolean false is the one value that hides prices", raw: false, expected: false },
    { name: "the boolean true shows prices", raw: true, expected: true },
  ];

  for (const { name, raw, expected } of cases) {
    it(name, () => {
      expect(parseSettingValue("show_prices", raw)).toBe(expected);
    });
  }
});

describe("getSetting", () => {
  const cases: Array<{
    name: string;
    outcome: { data: { value: unknown } | null; error: unknown };
    expected: boolean;
    logs: boolean;
  }> = [
    {
      name: "reads the stored true",
      outcome: { data: { value: true }, error: null },
      expected: true,
      logs: false,
    },
    {
      name: "reads the stored false",
      outcome: { data: { value: false }, error: null },
      expected: false,
      logs: false,
    },
    {
      name: "a table with no such row shows prices",
      outcome: { data: null, error: null },
      expected: true,
      logs: false,
    },
    {
      name: "a malformed stored value shows prices",
      outcome: { data: { value: "no" }, error: null },
      expected: true,
      logs: false,
    },
    {
      // The outage case: a settings query that fails must never be the reason a
      // catalogue renders without prices.
      name: "a failed query shows prices, and says so in the log",
      outcome: { data: null, error: { message: "connection refused" } },
      expected: true,
      logs: true,
    },
  ];

  for (const { name, outcome, expected, logs } of cases) {
    it(name, async () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      await expect(getSetting(fakeClient(outcome), "show_prices")).resolves.toBe(
        expected,
      );
      expect(spy.mock.calls.length > 0).toBe(logs);
    });
  }
});

describe("parseSettingKey", () => {
  const cases: Array<{ name: string; raw: unknown; ok: boolean }> = [
    { name: "the registered key", raw: "show_prices", ok: true },
    { name: "the registered key with whitespace", raw: "  show_prices  ", ok: true },
    { name: "an unknown key", raw: "drop_table", ok: false },
    { name: "a prototype property is not a key", raw: "toString", ok: false },
    { name: "a non-string", raw: 7, ok: false },
    { name: "nothing at all", raw: undefined, ok: false },
  ];

  for (const { name, raw, ok } of cases) {
    it(name, () => {
      const parsed = parseSettingKey(raw);
      expect(parsed.ok).toBe(ok);
      if (!parsed.ok) expect(parsed.error).toBe("BAD_KEY");
    });
  }
});

describe("parseSettingInput — the toggle's two values", () => {
  const cases: Array<{ name: string; raw: unknown; expected: boolean | "BAD_VALUE" }> = [
    { name: '"1" turns prices on', raw: "1", expected: true },
    { name: '"0" turns prices off', raw: "0", expected: false },
    { name: 'an unchecked checkbox\'s "on" is refused, not read as true', raw: "on", expected: "BAD_VALUE" },
    { name: "a missing field is refused, not read as false", raw: undefined, expected: "BAD_VALUE" },
    { name: "an empty string is refused", raw: "", expected: "BAD_VALUE" },
    { name: "true as a boolean is refused (forms send text)", raw: true, expected: "BAD_VALUE" },
    { name: '"true" is refused', raw: "true", expected: "BAD_VALUE" },
  ];

  for (const { name, raw, expected } of cases) {
    it(name, () => {
      const parsed = parseSettingInput("show_prices", raw);
      if (expected === "BAD_VALUE") {
        expect(parsed).toEqual({ ok: false, error: "BAD_VALUE" });
      } else {
        expect(parsed).toEqual({ ok: true, value: expected });
      }
    });
  }
});

describe("the registry", () => {
  it("lists exactly the keys it declares", () => {
    expect(SETTING_KEYS).toEqual(["show_prices"]);
    for (const key of SETTING_KEYS) expect(isSettingKey(key)).toBe(true);
  });

  it("keeps SETTINGS_DEFAULTS in step with the specs", () => {
    for (const key of SETTING_KEYS) {
      expect(SETTINGS_DEFAULTS[key]).toBe(SETTINGS[key].default);
    }
  });

  /** Prices ON is the owner's decision; a silent flip of this default is a bug. */
  it("defaults show_prices to true", () => {
    expect(SETTINGS_DEFAULTS.show_prices).toBe(true);
  });

  it("recognises every result code the action can redirect with", () => {
    for (const code of [...SETTINGS_ERRORS, "ok"]) {
      expect(isSettingsResult(code)).toBe(true);
    }
    expect(isSettingsResult("OK")).toBe(false);
    expect(isSettingsResult("")).toBe(false);
    expect(isSettingsResult("<script>")).toBe(false);
  });
});
