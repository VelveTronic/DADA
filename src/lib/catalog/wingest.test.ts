import { describe, expect, it } from "vitest";
import {
  WINGEST_PRICE_CSV_HEADER,
  hasAnyPrice,
  parseWingestPriceCsv,
  toWingestPricePatch,
  type WingestPriceRow,
} from "./wingest";

const SYNCED_AT = "2026-08-15T09:00:00.000Z";
/** U+FEFF by code point: an invisible literal in source is unreviewable. */
const BOM = String.fromCharCode(0xfeff);

const row = (overrides: Partial<WingestPriceRow> = {}): WingestPriceRow => ({
  codart: "4-007",
  p1: "3.50",
  p2: "3.40",
  p3: "3.30",
  p4: "3.20",
  p5: "3.10",
  p6: "3.00",
  unidad: "UNIDAD",
  unilot: "12",
  ...overrides,
});

describe("parseWingestPriceCsv", () => {
  it("reads the rows the owner-run export writes", () => {
    const rows = parseWingestPriceCsv(
      `${WINGEST_PRICE_CSV_HEADER}\r\n4-007,3.50,3.40,0,0,0,0,KG,0\r\n100-034A,1,1,1,1,1,1,CAJA,6\r\n`,
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      codart: "4-007",
      p1: "3.50",
      p2: "3.40",
      p3: "0",
      p4: "0",
      p5: "0",
      p6: "0",
      unidad: "KG",
      unilot: "0",
    });
    expect(rows[1].codart).toBe("100-034A");
  });

  it("ignores blank lines and trims the codart", () => {
    const rows = parseWingestPriceCsv(
      `${WINGEST_PRICE_CSV_HEADER}\n 4-007 ,0,0,0,0,0,0,,\n\n   \n`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].codart).toBe("4-007");
  });

  it("tolerates a BOM added by a spreadsheet round-trip", () => {
    const rows = parseWingestPriceCsv(
      `${BOM}${WINGEST_PRICE_CSV_HEADER}\n4-007,0,0,0,0,0,0,KG,0\n`,
    );
    expect(rows).toHaveLength(1);
  });

  it("returns no rows for a header-only export", () => {
    expect(parseWingestPriceCsv(`${WINGEST_PRICE_CSV_HEADER}\n`)).toEqual([]);
  });

  it("rejects a foreign header instead of guessing the columns", () => {
    expect(() => parseWingestPriceCsv("codart,precio\n4-007,3.50\n")).toThrow(
      /header/i,
    );
  });

  it("rejects a row whose field count does not match, naming the line", () => {
    expect(() =>
      parseWingestPriceCsv(`${WINGEST_PRICE_CSV_HEADER}\n4-007,0,0,0,0,0,0,KG\n`),
    ).toThrow(/line 2 has 8 fields/);
  });

  it("rejects an empty codart, naming the line", () => {
    expect(() =>
      parseWingestPriceCsv(`${WINGEST_PRICE_CSV_HEADER}\n,0,0,0,0,0,0,KG,0\n`),
    ).toThrow(/line 2 has an empty codart/);
  });
});

describe("toWingestPricePatch", () => {
  it("converts every euro tier to integer cents", () => {
    expect(toWingestPricePatch(row(), SYNCED_AT)).toMatchObject({
      price_1_cents: 350,
      price_2_cents: 340,
      price_3_cents: 330,
      price_4_cents: 320,
      price_5_cents: 310,
      price_6_cents: 300,
    });
  });

  it("turns a ZERO tier into NULL, never 0 cents", () => {
    // A 0-cent price is orderable and would sell the product for free; NULL keeps
    // create_order's NO_PRICE gate closed.
    const patch = toWingestPricePatch(
      row({ p1: "0", p2: "0.00", p3: "0.000", p4: "0.004", p5: "", p6: "  " }),
      SYNCED_AT,
    );
    expect(patch.price_1_cents).toBeNull();
    expect(patch.price_2_cents).toBeNull();
    expect(patch.price_3_cents).toBeNull();
    expect(patch.price_4_cents).toBeNull();
    expect(patch.price_5_cents).toBeNull();
    expect(patch.price_6_cents).toBeNull();
  });

  it("throws on a malformed price, naming the codart and the column", () => {
    expect(() =>
      toWingestPricePatch(row({ codart: "A6-092B", p3: "3,50e" }), SYNCED_AT),
    ).toThrow(/p3 for codart A6-092B/);
  });

  it("throws on a negative price, naming the codart", () => {
    expect(() =>
      toWingestPricePatch(row({ codart: "9-001", p1: "-1.00" }), SYNCED_AT),
    ).toThrow(/9-001/);
  });

  it("derives is_weighed from the KG unit", () => {
    const patch = toWingestPricePatch(row({ unidad: " kg " }), SYNCED_AT);
    expect(patch.unit).toBe("KG");
    expect(patch.is_weighed).toBe(true);
  });

  it("does not treat a KG-like unit as KG", () => {
    // Only the exact unit KG derives is_weighed. If the ERP vocabulary turns out
    // to be KGS or KILO, the merge report's unidadValues histogram shows it
    // before any write, and the rule here is what gets widened — silently
    // matching a prefix would flag boxed goods as sold by weight.
    const patch = toWingestPricePatch(row({ unidad: "KGS" }), SYNCED_AT);
    expect(patch.unit).toBe("KGS");
    expect("is_weighed" in patch).toBe(false);
  });

  it("never writes is_weighed=false for a non-KG unit", () => {
    // Staff may have hand-set the flag; the ERP unit alone must not clear it.
    const patch = toWingestPricePatch(row({ unidad: "caja" }), SYNCED_AT);
    expect(patch.unit).toBe("CAJA");
    expect(patch.is_weighed).toBeUndefined();
    expect("is_weighed" in patch).toBe(false);
  });

  it("leaves unit and is_weighed untouched when the CSV unit is empty", () => {
    const patch = toWingestPricePatch(row({ unidad: "   " }), SYNCED_AT);
    expect(patch.unit).toBeUndefined();
    expect("unit" in patch).toBe(false);
    expect("is_weighed" in patch).toBe(false);
  });

  /**
   * The factor multiplies MONEY — the catalogue's per-caja price is
   * `price_cents x units_per_case` and so is every order line — so the only
   * question each case answers is "how many base units is one caja". Everything
   * that is not a whole number of them is 1, the value that leaves the price
   * exactly as it was.
   */
  describe("UNILOT → units_per_case", () => {
    const factor = (unilot: string) =>
      toWingestPricePatch(row({ unilot }), SYNCED_AT).units_per_case;

    const cases: Array<{ name: string; unilot: string; expected: number }> = [
      { name: "a real case size survives", unilot: "24", expected: 24 },
      { name: "the driver's trailing .0 is still a whole number", unilot: "2.0", expected: 2 },
      { name: "0 means 'not sold by the case'", unilot: "0", expected: 1 },
      { name: "a NULL column arrives as an empty cell", unilot: "", expected: 1 },
      { name: "so does a blank one", unilot: "   ", expected: 1 },
      { name: "a negative is ERP junk", unilot: "-3", expected: 1 },
      // A fraction of a bottle is not a caja anyone can order, and 33 products
      // in the live catalogue actually hold one.
      { name: "a fraction cannot be a case size", unilot: "6.5", expected: 1 },
      // No longer an exception: the header check is the shape canary, and the
      // nightly sync must not stop on one junk field. See `unitsPerCase`.
      { name: "text that is not a number at all", unilot: "caja", expected: 1 },
      { name: "a value too big for the integer column", unilot: "1e21", expected: 1 },
    ];

    for (const { name, unilot, expected } of cases) {
      it(`${name}: "${unilot}" → ${expected}`, () => {
        expect(factor(unilot)).toBe(expected);
      });
    }

    it("is never null, so nothing downstream needs a fallback", () => {
      for (const { unilot } of cases) {
        expect(typeof factor(unilot)).toBe("number");
      }
    });
  });

  it("stamps the caller's sync timestamp", () => {
    expect(toWingestPricePatch(row(), SYNCED_AT).erp_synced_at).toBe(SYNCED_AT);
  });

  it("never carries codart into the patch: it is the update filter, not a value", () => {
    expect("codart" in toWingestPricePatch(row(), SYNCED_AT)).toBe(false);
  });
});

describe("hasAnyPrice", () => {
  it("is true when at least one tier survived", () => {
    const patch = toWingestPricePatch(
      row({ p1: "0", p2: "0", p3: "0", p4: "0", p5: "0", p6: "2.00" }),
      SYNCED_AT,
    );
    expect(hasAnyPrice(patch)).toBe(true);
  });

  it("is false when every tier is NULL", () => {
    const patch = toWingestPricePatch(
      row({ p1: "0", p2: "0", p3: "0", p4: "0", p5: "0", p6: "0" }),
      SYNCED_AT,
    );
    expect(hasAnyPrice(patch)).toBe(false);
  });
});
