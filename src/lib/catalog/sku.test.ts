import { describe, expect, it } from "vitest";
import { parseSku } from "./sku";

describe("parseSku", () => {
  it("splits an ERP trailing variant", () => {
    expect(parseSku("100-034A")).toEqual({ base: "100-034", suffix: "A" });
  });

  it("keeps non-variant letters", () => {
    expect(parseSku("A6-092")).toEqual({ base: "A6-092", suffix: "" });
    expect(parseSku("V-011")).toEqual({ base: "V-011", suffix: "" });
  });

  it("trims source whitespace", () => {
    expect(parseSku(" 4-007 ")).toEqual({ base: "4-007", suffix: "" });
  });
});
