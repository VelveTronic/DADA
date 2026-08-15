import { describe, expect, it } from "vitest";
import { localizedName, sanitizeSearch } from "./display";

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
  it("returns empty for whitespace-only", () => {
    expect(sanitizeSearch("   ")).toBe("");
  });
});
