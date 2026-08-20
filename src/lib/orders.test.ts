import { describe, expect, it } from "vitest";
import {
  ACTIVE_ORDER_STATUSES,
  addDays,
  CUSTOMER_ORDER_TABS,
  formatOrderDate,
  isCustomerOrderTab,
  isLineEditResult,
  isOrderErrorDetail,
  isOrderErrorKey,
  isOrderStatus,
  isUuid,
  LINE_EDIT_RESULTS,
  funnelWidth,
  madridDay,
  madridDayStartIso,
  madridMonthStartIso,
  mapLineEditError,
  mapOrderError,
  MAX_LINE_QTY,
  ORDER_STATUSES,
  orderUnits,
  parseOrderBridgeFailures,
  parseOrderNumber,
  parseReorderCount,
  QUEUE_TABS,
  safeQueueTab,
  statusesForTab,
  validateLineQty,
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

describe("madridMonthStartIso", () => {
  // Each row is an instant and the month start a `created_at >= …` filter has to
  // carry for it. The offsets are Madrid's own: +02:00 in summer, +01:00 in
  // winter.
  it.each([
    // Mid-month, one row per half of the year.
    ["2026-08-18T09:00:00Z", "2026-08-01T00:00:00+02:00"],
    ["2026-01-15T09:00:00Z", "2026-01-01T00:00:00+01:00"],
    // The rollover is MADRID's: 22:30 UTC on 31 August is already 1 September
    // there, so the month has turned while UTC still says August.
    ["2026-08-31T22:30:00Z", "2026-09-01T00:00:00+02:00"],
    // The same edge in winter, where the Madrid day turns an hour later.
    ["2026-01-31T23:30:00Z", "2026-02-01T00:00:00+01:00"],
    // A month that CONTAINS a switch still starts on the offset its first day
    // had — Madrid springs forward on 2026-03-29, three weeks after this start.
    ["2026-03-15T12:00:00Z", "2026-03-01T00:00:00+01:00"],
  ])("%s → %s", (now, expected) => {
    expect(madridMonthStartIso(new Date(now))).toBe(expected);
  });

  it("starts the month where the Spanish calendar starts it", () => {
    // The whole reason the offset is spelled out: the naive `…T00:00:00Z` would
    // begin two hours late and lose every order placed in the first two hours of
    // the 1st as a restaurant in Madrid counts them.
    expect(
      new Date(madridMonthStartIso(new Date("2026-08-18T09:00:00Z"))).toISOString(),
    ).toBe("2026-07-31T22:00:00.000Z");
  });
});

describe("madridDayStartIso", () => {
  // Each row is an instant and the day start a `created_at >= …` filter has to
  // carry for it. Madrid runs +01:00 in winter and +02:00 in summer, and the
  // two flip days are the reason this helper does not probe noon.
  it.each([
    // An ordinary summer day, and an ordinary winter one.
    ["2026-08-20T09:00:00Z", "2026-08-20T00:00:00+02:00"],
    ["2026-01-15T09:00:00Z", "2026-01-15T00:00:00+01:00"],
    // SPRING FLIP. Madrid springs forward on the last Sunday of March — 1 March
    // 2026 is a Sunday (1 Jan 2026 is a Thursday, and 1 March is day 60, so
    // 59 mod 7 = 3 days past Thursday), which puts Sundays on the 1st, 8th,
    // 15th, 22nd and 29th. On the 29th midnight is still CET: the changeover is
    // at 01:00 UTC = 02:00 local, two hours after the day began. A noon probe
    // would read +02:00 here and be an hour early.
    ["2026-03-29T09:00:00Z", "2026-03-29T00:00:00+01:00"],
    // AUTUMN FLIP. 1 October 2026 is a Thursday (day 274, so 273 mod 7 = 0 days
    // past Thursday), which puts the last Sunday on the 25th. Midnight there is
    // still CEST — the changeover is again at 01:00 UTC, 03:00 local — so the
    // day starts at +02:00 and a noon probe (+01:00) would drop its first hour.
    ["2026-10-25T09:00:00Z", "2026-10-25T00:00:00+02:00"],
    // The month helper's own edge, one calendar step down: 22:30 UTC on 19
    // August is already 00:30 on the 20th in Madrid, so the day has turned
    // while UTC still says the 19th.
    ["2026-08-19T22:30:00Z", "2026-08-20T00:00:00+02:00"],
    // The same edge in winter, where the Madrid day turns an hour later.
    ["2026-01-14T23:30:00Z", "2026-01-15T00:00:00+01:00"],
  ])("%s → %s", (now, expected) => {
    expect(madridDayStartIso(new Date(now))).toBe(expected);
  });

  // The arithmetic spelled out as instants, because the offset in the string is
  // only right if it names the moment the Spanish day actually began.
  it.each([
    // 2026-03-29 00:00 CET (+01:00) = 2026-03-28 23:00 UTC.
    ["2026-03-29T09:00:00Z", "2026-03-28T23:00:00.000Z"],
    // 2026-10-25 00:00 CEST (+02:00) = 2026-10-24 22:00 UTC.
    ["2026-10-25T09:00:00Z", "2026-10-24T22:00:00.000Z"],
    // An ordinary summer day: 2026-08-20 00:00 CEST = 2026-08-19 22:00 UTC.
    ["2026-08-20T09:00:00Z", "2026-08-19T22:00:00.000Z"],
  ])("%s starts the day at %s", (now, instant) => {
    expect(new Date(madridDayStartIso(new Date(now))).toISOString()).toBe(
      instant,
    );
  });

  it("never lands on a neighbouring civil day", () => {
    // The invariant behind the whole helper: whatever it stamps, Madrid agrees
    // it is the same day `madridDay` reports — including on both flip days.
    for (const now of [
      "2026-03-29T09:00:00Z",
      "2026-10-25T09:00:00Z",
      "2026-08-19T22:30:00Z",
      "2026-01-14T23:30:00Z",
    ]) {
      const start = madridDayStartIso(new Date(now));
      expect(madridDay(new Date(start))).toBe(madridDay(new Date(now)));
      // …and one millisecond earlier is the day BEFORE, which is what makes it
      // a boundary rather than merely a moment inside the day.
      expect(madridDay(new Date(new Date(start).getTime() - 1))).not.toBe(
        madridDay(new Date(now)),
      );
    }
  });
});

describe("funnelWidth", () => {
  it.each([
    // The ordinary ratios: the longest bar fills the track, the rest are its
    // fraction. 3/5 = 0.6 → 60%, 1/5 = 0.2 → 20%.
    [5, 5, "100%"],
    [3, 5, "60%"],
    [1, 5, "20%"],
    // A real zero is a real zero — an empty bar beside a figure that says 0.
    [0, 5, "0%"],
    // An EMPTY pipeline. Without the guard this is 0/0 = NaN, `width: NaN%` is
    // dropped by the browser, and every bar renders full for a queue that holds
    // nothing at all.
    [0, 0, "0%"],
    // A count that never arrived: empty track, and the figure draws an em dash.
    [null, 5, "0%"],
    [null, 0, "0%"],
    // Rounded to a tenth: 1/3 = 33.333…% and 2/3 = 66.666…%.
    [1, 3, "33.3%"],
    [2, 3, "66.7%"],
  ])("(%s of %s) → %s", (n, max, expected) => {
    expect(funnelWidth(n, max)).toBe(expected);
  });
});

describe("ACTIVE_ORDER_STATUSES", () => {
  it("is every status except the two that END an order", () => {
    // Derived from the full list rather than retyped: a status added to
    // `orders_status_check` and to `ORDER_STATUSES` has to be classified here
    // too, and this is what fails if it is not.
    expect([...ACTIVE_ORDER_STATUSES]).toEqual(
      ORDER_STATUSES.filter(
        (status) => status !== "albaran" && status !== "cancelled",
      ),
    );
  });

  it("holds only states the check constraint allows", () => {
    for (const status of ACTIVE_ORDER_STATUSES) {
      expect(isOrderStatus(status)).toBe(true);
    }
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
    // reach a customer's screen and needs a label like every other state.
    expect(ORDER_STATUSES).toEqual([
      "submitted",
      "confirmed",
      "processing",
      "bridge_failed",
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
  it("keeps `?estado=` to the four views the queue offers", () => {
    expect(QUEUE_TABS).toEqual([
      "submitted",
      "confirmed",
      "bridge_failed",
      "all",
    ]);
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

/**
 * The customer's own four views, and the reason they are four rather than
 * seven: `?tab=` is user-editable, it reaches `.in("status", …)`, and no chip on
 * that row may name a state the bridge owns.
 */
describe("customer order tabs", () => {
  it("offers exactly the four views the chip row draws", () => {
    expect(CUSTOMER_ORDER_TABS).toEqual(["all", "active", "done", "cancelled"]);
    for (const tab of CUSTOMER_ORDER_TABS) {
      expect(isCustomerOrderTab(tab), tab).toBe(true);
    }
  });

  it("rejects anything else, so a hand-edited `?tab=` falls back to 全部", () => {
    // A real STATUS is not a tab: `injected` would otherwise reach the query
    // through a validator that said yes, and put our plumbing on a chip.
    for (const value of [
      "injected",
      "submitted",
      "albaran",
      "ALL",
      "",
      "toString",
      "__proto__",
    ]) {
      expect(isCustomerOrderTab(value), value).toBe(false);
    }
  });

  it("maps each tab onto the statuses it stands for", () => {
    // `all` is the ABSENCE of a filter, not a status of its own.
    expect(statusesForTab("all")).toBeNull();
    expect(statusesForTab("active")).toEqual(ACTIVE_ORDER_STATUSES);
    expect(statusesForTab("done")).toEqual(["albaran"]);
    expect(statusesForTab("cancelled")).toEqual(["cancelled"]);
  });

  it("groups the bridge's three states under 进行中 and nowhere else", () => {
    const active = statusesForTab("active") ?? [];
    for (const status of ["processing", "bridge_failed", "injected"] as const) {
      expect(active, status).toContain(status);
    }
    // …and `injected` is emphatically not 已完成: Wingest having the order is
    // not the same sentence as the restaurant having the vegetables.
    expect(statusesForTab("done")).toEqual(["albaran"]);
  });

  it("covers every status exactly once across the three filtered tabs", () => {
    const filtered = [
      ...(statusesForTab("active") ?? []),
      ...(statusesForTab("done") ?? []),
      ...(statusesForTab("cancelled") ?? []),
    ];
    expect([...filtered].sort()).toEqual([...ORDER_STATUSES].sort());
  });
});

describe("orderUnits", () => {
  it("adds a card's quantities up", () => {
    expect(orderUnits([])).toBe(0);
    expect(orderUnits([2, 3, 1])).toBe(6);
  });

  it("rounds the float noise weighed lines produce", () => {
    expect(0.1 + 0.2).not.toBe(0.3); // the reason for the rounding
    expect(orderUnits([0.1, 0.2])).toBe(0.3);
    expect(orderUnits([2.5, 1.25])).toBe(3.75);
    expect(orderUnits([1.005, 2.115])).toBe(3.12);
  });
});

describe("parseReorderCount", () => {
  it("takes the counts this build writes into the redirect", () => {
    expect(parseReorderCount("0")).toBe(0);
    expect(parseReorderCount("5")).toBe(5);
    expect(parseReorderCount("200")).toBe(200);
  });

  it("answers 0 — no banner — for anything else", () => {
    for (const value of ["abc", "-1", "1.5", "1e3", "1000", "", " 5", "5 "]) {
      expect(parseReorderCount(value), value).toBe(0);
    }
    expect(parseReorderCount(undefined)).toBe(0);
    expect(parseReorderCount(null)).toBe(0);
  });
});

describe("parseOrderBridgeFailures", () => {
  const ORDER_ID = "11111111-1111-4111-8111-111111111111";

  it("maps the staff-only RPC JSON into the UI shape", () => {
    expect(
      parseOrderBridgeFailures([
        {
          order_id: ORDER_ID,
          status: "bridge_failed",
          attempt_count: 3,
          last_error_code: "BAD_QTY_STEP",
          last_error_message: "BAD_QTY_STEP:ART-1",
          failed_at: "2026-08-17T00:00:00Z",
          next_attempt_at: null,
        },
      ]),
    ).toEqual([
      {
        orderId: ORDER_ID,
        status: "bridge_failed",
        attemptCount: 3,
        lastErrorCode: "BAD_QTY_STEP",
        lastErrorMessage: "BAD_QTY_STEP:ART-1",
        failedAt: "2026-08-17T00:00:00Z",
        nextAttemptAt: null,
      },
    ]);
  });

  it("omits malformed rows instead of throwing away the queue", () => {
    expect(
      parseOrderBridgeFailures([
        null,
        "bad",
        { order_id: "not-a-uuid", status: "bridge_failed", attempt_count: 1 },
        {
          order_id: ORDER_ID,
          status: "bridge_failed",
          attempt_count: -1,
          last_error_code: null,
          last_error_message: null,
          failed_at: null,
          next_attempt_at: null,
        },
      ]),
    ).toEqual([]);
    expect(parseOrderBridgeFailures({ rows: [] })).toEqual([]);
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

describe("validateLineQty", () => {
  /**
   * The table IS the contract `staff_update_order_line` enforces one round trip
   * later, so each row is a quantity the RPC was actually asked about against the
   * live database (2026-08-16) and answered the same way.
   */
  const cases: [number, boolean, string | null][] = [
    // Whole quantities are fine either way — a weighed line may be exactly 5 kg.
    [1, false, null],
    [1, true, null],
    [3, false, null],
    [MAX_LINE_QTY, false, null],
    [MAX_LINE_QTY, true, null],
    // The owner's own example: 柠檬 ordered as 1, weighed at 5.2 kg.
    [5.2, true, null],
    [0.5, true, null],
    [1.235, true, null],
    // …and the same fraction on a product nobody has flagged as weighed.
    [5.2, false, "BAD_QTY_STEP"],
    [0.5, false, "BAD_QTY_STEP"],
    // Four decimals are past what `numeric(10,3)` can hold, weighed or not.
    [1.2345, true, "BAD_QTY"],
    [1.2345, false, "BAD_QTY"],
    // Zero is removal, and removal is out of scope: cancel the order instead.
    [0, true, "BAD_QTY"],
    [0, false, "BAD_QTY"],
    [-1, true, "BAD_QTY"],
    [-0.5, true, "BAD_QTY"],
    // Over the cookie's cap, and the two values a bad parse produces.
    [MAX_LINE_QTY + 1, true, "BAD_QTY"],
    [Number.NaN, true, "BAD_QTY"],
    [Number.POSITIVE_INFINITY, true, "BAD_QTY"],
  ];

  for (const [qty, isWeighed, expected] of cases) {
    it(`${qty} on a ${isWeighed ? "weighed" : "non-weighed"} line → ${expected ?? "ok"}`, () => {
      expect(validateLineQty(qty, isWeighed)).toBe(expected);
    });
  }

  it("agrees with the cart on what three decimals means", () => {
    // Binary floating point: 5.2 * 1000 is not 5200, and 1.005 * 1000 is not
    // 1005. Both are still three-decimal quantities, and both round-trip — which
    // is the whole reason the check is written as a round-trip rather than as a
    // digit count on `String(qty)`.
    expect(validateLineQty(5.2, true)).toBe(null);
    expect(validateLineQty(1.005, true)).toBe(null);
    expect(validateLineQty(0.001, true)).toBe(null);
    expect(validateLineQty(0.0001, true)).toBe("BAD_QTY");
  });
});

describe("mapLineEditError", () => {
  it("maps what staff_update_order_line raises", () => {
    expect(mapLineEditError("BAD_LINE")).toBe("BAD_LINE");
    expect(mapLineEditError("BAD_QTY")).toBe("BAD_QTY");
    // The RPC appends the codart, exactly as create_order does.
    expect(mapLineEditError("BAD_QTY_STEP:F-003")).toBe("BAD_QTY_STEP");
  });

  it("calls everything else a DB_ERROR rather than guessing", () => {
    expect(mapLineEditError("STAFF_ONLY")).toBe("DB_ERROR");
    expect(mapLineEditError("NOTE_TOO_LONG")).toBe("DB_ERROR");
    expect(mapLineEditError("integer out of range")).toBe("DB_ERROR");
    expect(mapLineEditError("permission denied for function")).toBe("DB_ERROR");
    expect(mapLineEditError("")).toBe("DB_ERROR");
    expect(mapLineEditError(null)).toBe("DB_ERROR");
    expect(mapLineEditError(undefined)).toBe("DB_ERROR");
  });

  it("never reports a failure as a handled outcome", () => {
    // Neither is ever an exception, so neither may be read out of one: a message
    // that happens to start with the word must not redraw a failed edit as an
    // applied one, nor as the amber "somebody else got there first".
    expect(mapLineEditError("ok")).toBe("DB_ERROR");
    expect(mapLineEditError("WRONG_STATE")).toBe("DB_ERROR");
  });
});

describe("isLineEditResult", () => {
  it("guards `?lineResult=` against a hand-edited query string", () => {
    for (const result of LINE_EDIT_RESULTS) {
      expect(isLineEditResult(result), result).toBe(true);
    }
    expect(isLineEditResult("")).toBe(false);
    expect(isLineEditResult("toString")).toBe(false);
    expect(isLineEditResult("STAFF_ONLY")).toBe(false);
    expect(isLineEditResult("bad_qty")).toBe(false);
  });
});
