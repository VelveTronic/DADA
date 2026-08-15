import { describe, expect, it } from "vitest";
import {
  centsFromEuros,
  eurosFromCents,
  formatEuros,
  lineTotalCents,
} from "./money";

describe("money helpers", () => {
  it("converts euros and cents with integer rounding", () => {
    expect(centsFromEuros(12.345)).toBe(1235);
    expect(eurosFromCents(1235)).toBe(12.35);
  });

  it("rounds weighed line totals to cents", () => {
    expect(lineTotalCents(1.235, 799)).toBe(987);
  });

  it("formats Spanish and Chinese EUR values", () => {
    expect(formatEuros(123456, "es")).toContain("1234,56");
    expect(formatEuros(123456, "zh")).toContain("1,234.56");
  });
});
