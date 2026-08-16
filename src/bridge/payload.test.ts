import { describe, expect, it } from "vitest";
import {
  PayloadError,
  centsToEuros,
  lineParams,
  portalRef,
  resolveFecent,
  splitLines,
  type ClaimedOrderItem,
} from "./payload";

function item(overrides: Partial<ClaimedOrderItem> = {}): ClaimedOrderItem {
  return {
    codart: "4-007",
    qty: 5,
    units_per_case: 1,
    unit_price_cents: 1999,
    line_total_cents: 9995,
    is_weighed: false,
    is_erp_excluded: false,
    ...overrides,
  };
}

/**
 * The portal stores integer cents; Wingest stores euros. This is the single
 * place the two meet, so "exact" is the whole point: 19.99 must print as 19.99
 * and never as 19.990000000000002.
 */
describe("centsToEuros", () => {
  it("converts integer cents to a 2-decimal euro amount", () => {
    expect(centsToEuros(1999)).toBe(19.99);
    expect(centsToEuros(1999).toFixed(2)).toBe("19.99");
    expect(centsToEuros(5)).toBe(0.05);
    expect(centsToEuros(0)).toBe(0);
    expect(centsToEuros(100)).toBe(1);
  });

  it("stays exact at amounts far larger than any real order", () => {
    expect(centsToEuros(123456789).toFixed(2)).toBe("1234567.89");
  });

  it("round-trips back to the same integer cents", () => {
    for (const cents of [1, 7, 99, 100, 4999, 123456789]) {
      expect(Math.round(centsToEuros(cents) * 100)).toBe(cents);
    }
  });

  it("refuses anything that is not an integer number of cents", () => {
    expect(() => centsToEuros(19.99)).toThrow(PayloadError);
    expect(() => centsToEuros(Number.NaN)).toThrow(PayloadError);
    expect(() => centsToEuros(Number.POSITIVE_INFINITY)).toThrow(PayloadError);
  });
});

/**
 * NUMPEDCLI is char(30) and doubles as the dedup key AND as the "Su Pedido"
 * reference a warehouse operator reads off the printed pedido.
 */
describe("portalRef", () => {
  it("prefixes the portal order number", () => {
    expect(portalRef(1001)).toBe("PORTAL-1001");
  });

  it("fits the char(30) NUMPEDCLI column for every reachable order number", () => {
    expect(portalRef(1001).length).toBeLessThanOrEqual(30);
    // The widest order number JS can represent exactly still leaves room; a
    // postgres `integer` stops nine digits short of even this.
    expect(portalRef(Number.MAX_SAFE_INTEGER).length).toBeLessThanOrEqual(30);
  });

  it("rejects order numbers that are not positive integers", () => {
    expect(() => portalRef(0)).toThrow(PayloadError);
    expect(() => portalRef(-3)).toThrow(PayloadError);
    expect(() => portalRef(10.5)).toThrow(PayloadError);
  });

  it("rejects a number so large it would stringify in exponential form", () => {
    // "1.111...e+21" is only 29 characters, so the length assert alone would
    // have let this through as a dedup key that is not the order number.
    expect(() => portalRef(Number("1".repeat(22)))).toThrow(PayloadError);
  });
});

/**
 * FECENT is what the warehouse picks against, so it must never be in the past:
 * a pedido dated yesterday reads as already late the moment it is created.
 * `madridToday` is supplied by the caller (the injector reads it from SQL
 * Server, in Madrid time) — this function never touches a clock.
 */
describe("resolveFecent", () => {
  const today = "2026-08-16";

  it("keeps a delivery date in the future", () => {
    expect(resolveFecent("2026-08-20", today)).toBe("2026-08-20");
  });

  it("keeps a delivery date that is exactly today", () => {
    expect(resolveFecent(today, today)).toBe(today);
  });

  it("pulls a past delivery date forward to Madrid today", () => {
    expect(resolveFecent("2026-08-15", today)).toBe(today);
    expect(resolveFecent("2025-12-31", today)).toBe(today);
  });

  /**
   * The `show_delivery_date` switch's whole ERP contract. With the picker off,
   * checkout stores a null `delivery_date` and `bridge_claim_confirmed` carries
   * that null through the jsonb untouched — so this fallback is what dates the
   * pedido, and it must be the Madrid business day (FECPED semantics) rather
   * than a throw that would strand the order mid-lease.
   *
   * `undefined` is pinned beside `null` because the field is optional in the
   * TYPE as well: a claim payload that predates the column, or one whose key
   * never arrived, reaches here as `undefined` and must not be a crash either.
   */
  it("falls back to Madrid today when the order carries no delivery date", () => {
    expect(resolveFecent(null, today)).toBe(today);
    expect(resolveFecent(undefined, today)).toBe(today);
    expect(resolveFecent("", today)).toBe(today);
  });

  it("compares across month and year boundaries, not as text length", () => {
    expect(resolveFecent("2026-09-01", "2026-08-31")).toBe("2026-09-01");
    expect(resolveFecent("2026-01-01", "2026-12-31")).toBe("2026-12-31");
  });

  it("refuses a malformed date on either side", () => {
    expect(() => resolveFecent("16/08/2026", today)).toThrow(PayloadError);
    expect(() => resolveFecent("2026-8-16", today)).toThrow(PayloadError);
    expect(() => resolveFecent(today, "not-a-date")).toThrow(PayloadError);
    expect(() => resolveFecent(today, "")).toThrow(PayloadError);
  });

  it("refuses a calendar-impossible date", () => {
    expect(() => resolveFecent("2026-02-30", today)).toThrow(PayloadError);
    expect(() => resolveFecent("2026-13-01", today)).toThrow(PayloadError);
  });
});

/**
 * `is_erp_excluded` lines exist so staff can handle them by hand; the pedido
 * must not carry them. Everything downstream (header totals, the CONTRATO line
 * count) counts the INCLUDED lines only.
 */
describe("splitLines", () => {
  it("partitions on is_erp_excluded and keeps payload order", () => {
    const a = item({ codart: "A" });
    const b = item({ codart: "B", is_erp_excluded: true });
    const c = item({ codart: "C" });
    const { included, excluded } = splitLines([a, b, c]);
    expect(included.map((line) => line.codart)).toEqual(["A", "C"]);
    expect(excluded.map((line) => line.codart)).toEqual(["B"]);
  });

  it("reports an all-excluded order as zero included lines", () => {
    const { included, excluded } = splitLines([
      item({ codart: "A", is_erp_excluded: true }),
      item({ codart: "B", is_erp_excluded: true }),
    ]);
    expect(included).toHaveLength(0);
    expect(excluded).toHaveLength(2);
  });

  it("reports an empty order as zero included lines", () => {
    expect(splitLines([]).included).toHaveLength(0);
  });
});

/**
 * The commercial half of the pedido line. Prices come from the PAYLOAD — the
 * snapshot the customer confirmed — never from a fresh articulo read, which can
 * have drifted a nightly price sync away by the time the bridge runs.
 */
describe("lineParams", () => {
  it("carries the confirmed cents through as both cents and euros", () => {
    expect(lineParams(item())).toEqual({
      codart: "4-007",
      qty: 5,
      isWeighed: false,
      unitsPerCase: 1,
      unitPriceCents: 1999,
      lineTotalCents: 9995,
      unitPriceEuros: 19.99,
      lineTotalEuros: 99.95,
    });
  });

  it("keeps the quantity in CAJAS, next to the factor that converts it", () => {
    // 2 cajas of 24 stay 2 here: multiplying is the injector's job, because it
    // is the only side that knows Wingest counts bottles.
    const line = lineParams(item({ qty: 2, units_per_case: 24, line_total_cents: 4608 }));
    expect(line.qty).toBe(2);
    expect(line.unitsPerCase).toBe(24);
  });

  it("defaults an absent factor to 1, for a claim made before the RPC sent it", () => {
    const withoutFactor = item();
    delete withoutFactor.units_per_case;
    expect(lineParams(withoutFactor).unitsPerCase).toBe(1);
  });

  it("refuses a factor that is not a whole number of units per caja", () => {
    expect(() => lineParams(item({ units_per_case: 0 }))).toThrow(PayloadError);
    expect(() => lineParams(item({ units_per_case: -24 }))).toThrow(PayloadError);
    expect(() => lineParams(item({ units_per_case: 2.5 }))).toThrow(PayloadError);
    expect(() => lineParams(item({ units_per_case: Number.NaN }))).toThrow(PayloadError);
    // The code is what the bridge log will carry, so it is pinned.
    const error = (() => {
      try {
        lineParams(item({ units_per_case: 0 }));
      } catch (thrown) {
        return thrown as PayloadError;
      }
    })();
    expect(error?.code).toBe("BAD_UNITS_PER_CASE");
  });

  it("keeps fractional quantities for weighed products", () => {
    const line = lineParams(item({ qty: 1.235, is_weighed: true, line_total_cents: 2469 }));
    expect(line.qty).toBe(1.235);
    expect(line.lineTotalEuros).toBe(24.69);
  });

  it("carries the weighed flag through, so the injector can zero CAJ", () => {
    expect(lineParams(item({ qty: 5.2, is_weighed: true })).isWeighed).toBe(true);
    expect(lineParams(item()).isWeighed).toBe(false);
  });

  it("defaults an absent weighed flag to false, like the factor before it", () => {
    const withoutFlag = item();
    delete withoutFlag.is_weighed;
    expect(lineParams(withoutFlag).isWeighed).toBe(false);
  });

  it("refuses a weighed flag that is not a boolean", () => {
    // Guessing would decide whether a 5.2 kg line writes CAJ=0 or CAJ=5.
    const bad = { is_weighed: "true" } as unknown as Partial<ClaimedOrderItem>;
    expect(() => lineParams(item(bad))).toThrow(PayloadError);
    const error = (() => {
      try {
        lineParams(item(bad));
      } catch (thrown) {
        return thrown as PayloadError;
      }
    })();
    expect(error?.code).toBe("BAD_WEIGHED");
  });

  /**
   * No portal write path can produce this: `create_order` and
   * `staff_update_order_line` both raise BAD_QTY_STEP for a fraction on a
   * product nobody flagged as weighed. A claim carrying one means the row was
   * changed by something else, and the old code would have TRUNCATED it into
   * `CAJ` — 2.5 cajas silently becoming 2 on the albarán.
   */
  it("refuses a fractional quantity on a line that is not weighed", () => {
    expect(() => lineParams(item({ qty: 2.5 }))).toThrow(PayloadError);
    const error = (() => {
      try {
        lineParams(item({ qty: 2.5 }));
      } catch (thrown) {
        return thrown as PayloadError;
      }
    })();
    expect(error?.code).toBe("BAD_QTY_STEP");
    // …and the same quantity is perfectly fine once the product IS weighed.
    expect(lineParams(item({ qty: 2.5, is_weighed: true })).qty).toBe(2.5);
  });

  it("trims the codart the way every ERP lookup does", () => {
    expect(lineParams(item({ codart: "  4-007 " })).codart).toBe("4-007");
  });

  it("refuses a line the ERP could not represent", () => {
    expect(() => lineParams(item({ codart: "   " }))).toThrow(PayloadError);
    expect(() => lineParams(item({ qty: 0 }))).toThrow(PayloadError);
    expect(() => lineParams(item({ qty: -1 }))).toThrow(PayloadError);
    expect(() => lineParams(item({ unit_price_cents: 12.5 }))).toThrow(PayloadError);
    expect(() => lineParams(item({ line_total_cents: -1 }))).toThrow(PayloadError);
  });

  it("allows a zero unit price but not a negative one", () => {
    expect(lineParams(item({ unit_price_cents: 0, line_total_cents: 0 })).unitPriceEuros).toBe(0);
    expect(() => lineParams(item({ unit_price_cents: -1 }))).toThrow(PayloadError);
  });
});
