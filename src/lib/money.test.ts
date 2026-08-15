import { describe, expect, it } from "vitest";
import {
  cartSubtotalCents,
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

/**
 * What the phone's cart bar is allowed to show. It adds up prices the server
 * already resolved and refuses to answer at all when one is missing — a
 * subtotal quietly short a line is worse than no subtotal.
 */
describe("cartSubtotalCents", () => {
  const A = "11111111-1111-4111-8111-111111111111";
  const B = "22222222-2222-4222-8222-222222222222";

  it("sums qty × unit price, rounding weighed lines to cents", () => {
    expect(cartSubtotalCents({ [A]: 3, [B]: 1.235 }, { [A]: 250, [B]: 799 })).toBe(
      750 + 987,
    );
  });

  it("is 0 for an empty cart, not null", () => {
    expect(cartSubtotalCents({}, { [A]: 250 })).toBe(0);
  });

  it("answers null when any line has no price on this page", () => {
    expect(cartSubtotalCents({ [A]: 1, [B]: 2 }, { [A]: 250 })).toBeNull();
    expect(cartSubtotalCents({ [A]: 1 }, {})).toBeNull();
  });
});
