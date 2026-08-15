import { describe, expect, it } from "vitest";
import {
  addDays,
  isOrderErrorDetail,
  isOrderErrorKey,
  isUuid,
  madridDay,
  mapOrderError,
} from "./orders";

describe("madridDay", () => {
  it("reads the civil day in Madrid, not in UTC", () => {
    // 23:30 UTC in August is already tomorrow in Madrid (UTC+2).
    expect(madridDay(new Date("2026-08-15T23:30:00Z"))).toBe("2026-08-16");
    // 00:30 UTC in January is still the same day in Madrid (UTC+1).
    expect(madridDay(new Date("2026-01-01T00:30:00Z"))).toBe("2026-01-01");
    // …and 23:30 UTC on New Year's Eve is already the new year there.
    expect(madridDay(new Date("2025-12-31T23:30:00Z"))).toBe("2026-01-01");
  });
});

describe("addDays", () => {
  it("adds calendar days across months and years", () => {
    expect(addDays("2026-08-15", 60)).toBe("2026-10-14");
    expect(addDays("2026-08-15", 0)).toBe("2026-08-15");
    expect(addDays("2025-12-31", 1)).toBe("2026-01-01");
    expect(addDays("2024-02-28", 1)).toBe("2024-02-29");
    expect(addDays("2025-02-28", 1)).toBe("2025-03-01");
  });
  it("agrees with create_order's window on a DST boundary", () => {
    // Madrid springs forward on 2026-03-29; a day count must not shift by an
    // hour of offset, because `date + 60` in Postgres counts calendar days.
    expect(addDays("2026-03-01", 60)).toBe("2026-04-30");
  });
});

describe("isUuid", () => {
  it("accepts a uuid in either case and rejects anything else", () => {
    expect(isUuid("11111111-1111-4111-8111-111111111111")).toBe(true);
    expect(isUuid("11111111-1111-4111-8111-111111111111".toUpperCase())).toBe(
      true,
    );
    expect(isUuid("")).toBe(false);
    expect(isUuid("not-a-uuid")).toBe(false);
    expect(isUuid("11111111-1111-4111-8111-11111111111")).toBe(false);
    expect(isUuid("x".repeat(4000))).toBe(false);
  });
});

describe("mapOrderError", () => {
  it("maps the bare create_order codes", () => {
    expect(mapOrderError("NO_ACTIVE_COMPANY")).toEqual({
      key: "NO_ACTIVE_COMPANY",
      detail: null,
    });
    expect(mapOrderError("COMPANY_NOT_LINKED").key).toBe("COMPANY_NOT_LINKED");
    expect(mapOrderError("EMPTY_ORDER").key).toBe("EMPTY_ORDER");
    expect(mapOrderError("TOO_MANY_LINES").key).toBe("TOO_MANY_LINES");
    expect(mapOrderError("NOTE_TOO_LONG").key).toBe("NOTE_TOO_LONG");
    expect(mapOrderError("BAD_DELIVERY_DATE").key).toBe("BAD_DELIVERY_DATE");
    expect(mapOrderError("BAD_QTY").key).toBe("BAD_QTY");
  });

  it("splits a detailed code on its FIRST colon", () => {
    expect(mapOrderError("NO_PRICE:V-001:tier 1")).toEqual({
      key: "NO_PRICE",
      detail: "V-001",
    });
    expect(mapOrderError("BAD_QTY_STEP:V-001")).toEqual({
      key: "BAD_QTY_STEP",
      detail: "V-001",
    });
  });

  it("keeps the internal product uuid out of the customer's URL", () => {
    expect(
      mapOrderError("PRODUCT_UNAVAILABLE:11111111-1111-4111-8111-111111111111"),
    ).toEqual({ key: "PRODUCT_UNAVAILABLE", detail: null });
  });

  it("falls back to UNKNOWN for anything create_order did not raise", () => {
    // Reachable codes with no message of their own, plus real Postgres noise.
    expect(mapOrderError("BAD_LINE").key).toBe("UNKNOWN");
    expect(mapOrderError("IDEMPOTENCY_MISMATCH").key).toBe("UNKNOWN");
    expect(mapOrderError('relation "orders" does not exist').key).toBe(
      "UNKNOWN",
    );
    expect(mapOrderError("").key).toBe("UNKNOWN");
    expect(mapOrderError(null).key).toBe("UNKNOWN");
    expect(mapOrderError(undefined).key).toBe("UNKNOWN");
  });

  it("drops a detail that is not a plain codart", () => {
    expect(mapOrderError("NO_PRICE:<script>:tier 1").detail).toBe(null);
    expect(mapOrderError("NO_PRICE: :tier 1").detail).toBe(null);
    expect(mapOrderError(`NO_PRICE:${"A".repeat(200)}`).detail).toBe(null);
  });
});

describe("isOrderErrorKey", () => {
  it("recognises exactly the keys the cart namespace carries", () => {
    expect(isOrderErrorKey("NO_PRICE")).toBe(true);
    expect(isOrderErrorKey("UNKNOWN")).toBe(true);
    expect(isOrderErrorKey("")).toBe(false);
    expect(isOrderErrorKey("toString")).toBe(false);
    expect(isOrderErrorKey("BAD_LINE")).toBe(false);
  });
});

describe("isOrderErrorDetail", () => {
  it("accepts a codart and rejects crafted query-string junk", () => {
    expect(isOrderErrorDetail("V-001")).toBe(true);
    expect(isOrderErrorDetail("ABC.1/2")).toBe(true);
    expect(isOrderErrorDetail("")).toBe(false);
    expect(isOrderErrorDetail("-lead")).toBe(false);
    expect(isOrderErrorDetail("call DADA now at 900 123 456")).toBe(false);
    expect(isOrderErrorDetail("11111111-1111-4111-8111-111111111111")).toBe(
      false,
    );
  });
});
