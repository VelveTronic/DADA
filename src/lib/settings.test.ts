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
  parseToggleFormData,
  type SettingsClient,
} from "./settings";

/**
 * The whole point of these tests is the fail-open rule: these switches decide
 * whether a restaurant sees any price at all and whether it may choose a
 * delivery date, so the interesting cases are the broken ones — a missing row, a
 * jsonb value of the wrong shape, a SELECT that errored — and every one of them
 * has to answer with the setting's DEFAULT.
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

/**
 * Run against EVERY registered key rather than against `show_prices` alone: the
 * rule is the registry's, not one setting's, so a key added tomorrow inherits
 * this suite instead of quietly getting none.
 */
describe.each(SETTING_KEYS)("parseSettingValue — %s", (key) => {
  const fallback = SETTINGS_DEFAULTS[key];
  const malformed: Array<{ name: string; raw: unknown }> = [
    { name: "a missing row (undefined) falls back to the default", raw: undefined },
    { name: "a jsonb null falls back to the default", raw: null },
    { name: 'the string "false" is NOT false', raw: "false" },
    { name: 'the string "true" is not a boolean either', raw: "true" },
    { name: "the number 0 is not false", raw: 0 },
    { name: "the number 1 is not true, it is malformed", raw: 1 },
    { name: "an object is malformed", raw: { show: false } },
    { name: "an array is malformed", raw: [false] },
    { name: "an empty string is malformed", raw: "" },
  ];

  for (const { name, raw } of malformed) {
    it(name, () => {
      expect(parseSettingValue(key, raw)).toBe(fallback);
    });
  }

  it("the boolean false is the one value that hides anything", () => {
    expect(parseSettingValue(key, false)).toBe(false);
  });

  it("the boolean true shows it", () => {
    expect(parseSettingValue(key, true)).toBe(true);
  });
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

  /**
   * The reader is not `show_prices` with extra steps: the second switch reaches
   * the same four chained calls and answers off its own row, and a stored
   * `false` is what removes the delivery-date picker from every checkout.
   */
  it("reads the second switch off the same row shape", async () => {
    await expect(
      getSetting(fakeClient({ data: { value: false }, error: null }), "show_delivery_date"),
    ).resolves.toBe(false);
  });

  it("shows the delivery-date picker when its row is missing", async () => {
    await expect(
      getSetting(fakeClient({ data: null, error: null }), "show_delivery_date"),
    ).resolves.toBe(true);
  });
});

describe("parseSettingKey", () => {
  const cases: Array<{ name: string; raw: unknown; ok: boolean }> = [
    { name: "the registered key", raw: "show_prices", ok: true },
    { name: "the registered key with whitespace", raw: "  show_prices  ", ok: true },
    { name: "the second registered key", raw: "show_delivery_date", ok: true },
    // A near miss is still a miss: the table takes any text, so only the
    // registry stands between a typo'd hidden field and a row nothing reads.
    { name: "a near miss of a registered key", raw: "show_delivery_dates", ok: false },
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

describe("parseToggleFormData — the hidden/checkbox pair", () => {
  /** The two inputs `settings-form.tsx` posts, in the order a browser sends them. */
  const posted = (...values: string[]): FormData => {
    const formData = new FormData();
    for (const value of values) formData.append("value", value);
    return formData;
  };

  /**
   * THE test. The form always sends the hidden `0`, and the checkbox appends
   * `1` after it when the switch is on — so a reader that took the FIRST entry
   * (which is what `FormData.get` does) would answer `false` for BOTH positions
   * and hide every price from every restaurant, permanently, from a save the
   * owner made to turn prices ON. Nothing else in this suite would notice.
   */
  it("reads the LAST entry, so an ON switch is not read as its own hidden 0", () => {
    expect(parseToggleFormData(posted("0", "1"), "show_prices")).toEqual({
      ok: true,
      value: true,
    });
  });

  it("reads the lone hidden 0 an OFF switch leaves behind", () => {
    expect(parseToggleFormData(posted("0"), "show_prices")).toEqual({
      ok: true,
      value: false,
    });
  });

  it("refuses a body with no value field at all rather than reading it as off", () => {
    expect(parseToggleFormData(posted(), "show_prices")).toEqual({
      ok: false,
      error: "BAD_VALUE",
    });
  });

  it("refuses when the last entry is not one of the two values", () => {
    expect(parseToggleFormData(posted("0", "on"), "show_prices")).toEqual({
      ok: false,
      error: "BAD_VALUE",
    });
  });

  it("ignores fields that are not the toggle's own", () => {
    const formData = posted("0", "1");
    formData.append("key", "show_prices");
    formData.append("locale", "zh");
    expect(parseToggleFormData(formData, "show_prices")).toEqual({
      ok: true,
      value: true,
    });
  });
});

describe("the registry", () => {
  it("lists exactly the keys it declares", () => {
    expect(SETTING_KEYS).toEqual(["show_prices", "show_delivery_date"]);
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

  /**
   * …and so is the delivery-date picker. A default of `false` here would mean a
   * portal that quietly stopped asking for a delivery date the day a settings
   * row went missing, and every order after it going to the ERP dated today.
   */
  it("defaults show_delivery_date to true", () => {
    expect(SETTINGS_DEFAULTS.show_delivery_date).toBe(true);
  });

  /** Fail-open is the registry's rule, not one entry's: every switch shows. */
  it("defaults every switch to true", () => {
    for (const key of SETTING_KEYS) {
      expect(SETTINGS_DEFAULTS[key], key).toBe(true);
    }
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
