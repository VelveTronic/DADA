import { describe, expect, it } from "vitest";
import {
  addDays,
  formatOrderDate,
  isOrderErrorDetail,
  isOrderErrorKey,
  isOrderStatus,
  isUuid,
  madridDay,
  mapOrderError,
  ORDER_STATUSES,
  parseOrderNumber,
  QUEUE_TABS,
  safeQueueTab,
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

  it("never carries a detail off an unmapped message", () => {
    // An unrecognised code with a codart-shaped tail: without the UNKNOWN guard
    // this fragment lands on the cart page glued to "try again later".
    expect(mapOrderError("SOME_NEW_CODE:V-001")).toEqual({
      key: "UNKNOWN",
      detail: null,
    });
    expect(mapOrderError('invalid input syntax for type uuid: "x"')).toEqual({
      key: "UNKNOWN",
      detail: null,
    });
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

describe("ORDER_STATUSES", () => {
  it("is exactly what orders_status_check allows, in lifecycle order", () => {
    // `processing` is the bridge's claim state (bridge_claim_confirmed sets it,
    // bridge_mark_injected clears it). It is in the live constraint, so it can
    // reach a customer's screen and needs a label like the other five.
    expect(ORDER_STATUSES).toEqual([
      "submitted",
      "confirmed",
      "processing",
      "injected",
      "albaran",
      "cancelled",
    ]);
  });
});

describe("isOrderStatus", () => {
  it("guards a status read out of the database before it indexes a message", () => {
    for (const status of ORDER_STATUSES) {
      expect(isOrderStatus(status), status).toBe(true);
    }
    expect(isOrderStatus("")).toBe(false);
    expect(isOrderStatus("Submitted")).toBe(false);
    expect(isOrderStatus("toString")).toBe(false);
    expect(isOrderStatus("shipped")).toBe(false);
  });
});

describe("safeQueueTab", () => {
  it("keeps `?estado=` to the three views the queue offers", () => {
    expect(QUEUE_TABS).toEqual(["submitted", "confirmed", "all"]);
    for (const tab of QUEUE_TABS) expect(safeQueueTab(tab)).toBe(tab);
  });

  it("falls back to the pending view for anything else", () => {
    // A status the queue has no tab for is still not a tab: `injected` would
    // otherwise reach `.eq("status", …)` through a validator that said yes.
    expect(safeQueueTab("injected")).toBe("submitted");
    expect(safeQueueTab("cancelled")).toBe("submitted");
    expect(safeQueueTab("")).toBe("submitted");
    expect(safeQueueTab("toString")).toBe("submitted");
    expect(safeQueueTab(undefined)).toBe("submitted");
    expect(safeQueueTab(null)).toBe("submitted");
  });
});

describe("parseOrderNumber", () => {
  it("accepts a plain order number", () => {
    // The sequence starts at 1001.
    expect(parseOrderNumber("1001")).toBe(1001);
    expect(parseOrderNumber("999999999")).toBe(999_999_999);
  });

  it("renders no banner for anything that is not one", () => {
    expect(parseOrderNumber("0")).toBe(null);
    expect(parseOrderNumber("")).toBe(null);
    expect(parseOrderNumber(" 1001")).toBe(null);
    expect(parseOrderNumber("1001abc")).toBe(null);
    expect(parseOrderNumber("1e3")).toBe(null);
    expect(parseOrderNumber("-1")).toBe(null);
    expect(parseOrderNumber("1.5")).toBe(null);
    expect(parseOrderNumber("1234567890")).toBe(null);
    expect(parseOrderNumber(undefined)).toBe(null);
    expect(parseOrderNumber(null)).toBe(null);
  });
});

describe("formatOrderDate", () => {
  it("keeps a plain delivery date on its own day, in either locale", () => {
    // `delivery_date` is a `date`: no time, no zone. Parsed as UTC midnight and
    // formatted in a zone BEHIND UTC it would come back out as the 15th.
    expect(formatOrderDate("2026-08-16", "es")).toBe("16/08/2026");
    expect(formatOrderDate("2026-08-16", "zh")).toBe("2026/08/16");
  });

  it("reads a timestamp on Madrid's calendar, like madridDay", () => {
    // 23:30 UTC in August is already tomorrow in Madrid — the same calendar the
    // delivery window is judged on, so both dates in a row agree.
    expect(formatOrderDate("2026-08-15T23:30:00Z", "es")).toBe("16/08/2026");
    expect(formatOrderDate("2025-12-31T23:30:00Z", "zh")).toBe("2026/01/01");
  });

  it("renders nothing for a value it cannot parse", () => {
    expect(formatOrderDate("", "es")).toBe("");
    expect(formatOrderDate("not a date", "zh")).toBe("");
  });
});
