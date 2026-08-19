import { describe, expect, it } from "vitest";
import { localizedName, sanitizeSearch, unitLabel } from "./display";

describe("localizedName", () => {
  it("picks the requested locale", () => {
    expect(localizedName({ zh: "圆糯米", es: "ARROZ" }, "zh")).toBe("圆糯米");
    expect(localizedName({ zh: "圆糯米", es: "ARROZ" }, "es")).toBe("ARROZ");
  });
  it("falls back zh→es and es→zh", () => {
    expect(localizedName({ es: "ARROZ" }, "zh")).toBe("ARROZ");
    expect(localizedName({ zh: "圆糯米" }, "es")).toBe("圆糯米");
  });
  it("tolerates malformed json values", () => {
    expect(localizedName(null, "zh")).toBe("");
    expect(localizedName("ARROZ" as unknown, "zh")).toBe("");
    expect(localizedName({ fr: "RIZ" } as unknown, "zh")).toBe("");
    expect(localizedName(["ARROZ"] as unknown, "zh")).toBe("");
  });
  it("falls back when a present key holds a json null", () => {
    expect(localizedName({ zh: null, es: "ARROZ" }, "zh")).toBe("ARROZ");
  });
  it("ignores non-string values", () => {
    expect(localizedName({ zh: 123 } as unknown, "zh")).toBe("");
  });
});

describe("unitLabel", () => {
  it("names the case content when a caja really holds several units", () => {
    expect(unitLabel("CAJA", 24)).toBe("CAJA×24");
    expect(unitLabel("UNIDAD", 2)).toBe("UNIDAD×2");
  });

  /**
   * 1 is the column's default and the fallback for every UNILOT the ERP could
   * not answer, so it is not a statement about packaging and must not read as
   * one. It is also most of the catalogue.
   */
  it("says nothing at all when the factor is 1", () => {
    expect(unitLabel("CAJA", 1)).toBe("CAJA");
    expect(unitLabel("KG", 1)).toBe("KG");
  });

  it("tolerates the nulls the priced view's types allow", () => {
    expect(unitLabel("CAJA", null)).toBe("CAJA");
    expect(unitLabel(null, 24)).toBe("");
    expect(unitLabel(undefined, undefined)).toBe("");
  });

  it("ignores a factor the DB constraint should have made impossible", () => {
    expect(unitLabel("CAJA", 0)).toBe("CAJA");
    expect(unitLabel("CAJA", -4)).toBe("CAJA");
    expect(unitLabel("CAJA", 6.5)).toBe("CAJA");
    expect(unitLabel("CAJA", Number.NaN)).toBe("CAJA");
  });
});

describe("sanitizeSearch", () => {
  it("strips PostgREST syntax characters and trims", () => {
    expect(sanitizeSearch("  jamón, (5%) ")).toBe("jamón 5");
  });
  it("caps length at 40", () => {
    expect(sanitizeSearch("a".repeat(60))).toHaveLength(40);
  });
  it("strips ilike wildcards and escapes", () => {
    expect(sanitizeSearch("a*b.c\\d")).toBe("a b c d");
  });
  /**
   * `_` is LIKE's single-character wildcard, so a query left holding one matches
   * more than the customer typed — `a_c` would answer with `abc` too. Stripped,
   * it can only ever be read literally.
   */
  it("strips the single-character wildcard", () => {
    expect(sanitizeSearch("a_c")).toBe("a c");
    expect(sanitizeSearch("ARZ_01")).toBe("ARZ 01");
  });
  it("collapses a query that was nothing but a wildcard", () => {
    expect(sanitizeSearch("_")).toBe("");
    expect(sanitizeSearch("__%")).toBe("");
  });
  it("returns empty for whitespace-only", () => {
    expect(sanitizeSearch("   ")).toBe("");
  });
});
