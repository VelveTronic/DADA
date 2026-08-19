import { describe, expect, it } from "vitest";
import type { Cart } from "./cart";
import {
  CART_COOKIE,
  CART_MAX_LINES,
  cartUnits,
  isProductId,
  mergeReorderLines,
  parseCart,
  serializeCart,
  setQty,
  trySetQty,
} from "./cart";

describe("cart codec", () => {
  it("round-trips", () => {
    const c = {
      "11111111-1111-4111-8111-111111111111": 2,
      "22222222-2222-4222-8222-222222222222": 0.5,
    };
    expect(parseCart(serializeCart(c))).toEqual(c);
  });
  it("rejects garbage to an empty cart", () => {
    expect(parseCart(undefined)).toEqual({});
    expect(parseCart("not json")).toEqual({});
    expect(parseCart("[1,2]")).toEqual({});
    expect(parseCart('{"x": "nan"}')).toEqual({});
    expect(parseCart('{"11111111-1111-4111-8111-111111111111": -2}')).toEqual(
      {},
    );
  });
  it("drops non-uuid keys, prototype-ish ones included", () => {
    expect(
      parseCart(
        '{"__proto__":1,"constructor":2,"11111111-1111-4111-8111-111111111111":2}',
      ),
    ).toEqual({ "11111111-1111-4111-8111-111111111111": 2 });
  });
  it("truncates an over-cap cookie to CART_MAX_LINES", () => {
    const raw: Record<string, number> = {};
    for (let i = 0; i < CART_MAX_LINES + 25; i++) {
      raw[`00000000-0000-4000-8000-${String(i).padStart(12, "0")}`] = 1;
    }
    expect(Object.keys(parseCart(JSON.stringify(raw)))).toHaveLength(
      CART_MAX_LINES,
    );
  });
  it("setQty adds, updates, and removes at qty<=0", () => {
    let c = setQty({}, "11111111-1111-4111-8111-111111111111", 3);
    c = setQty(c, "11111111-1111-4111-8111-111111111111", 5);
    expect(c["11111111-1111-4111-8111-111111111111"]).toBe(5);
    c = setQty(c, "11111111-1111-4111-8111-111111111111", 0);
    expect(c).toEqual({});
  });
  it("caps lines at CART_MAX_LINES", () => {
    let c: Record<string, number> = {};
    for (let i = 0; i < CART_MAX_LINES; i++)
      c = setQty(c, `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, 1);
    expect(() =>
      setQty(c, "99999999-9999-4999-8999-999999999999", 1),
    ).toThrow("CART_FULL");
    expect(setQty(c, `00000000-0000-4000-8000-${"0".repeat(12)}`, 2)).toBeTruthy(); // updating an existing line is fine
  });
  it("clamps precision to 3 decimals and rejects absurd qty", () => {
    const c = setQty({}, "11111111-1111-4111-8111-111111111111", 0.1234);
    expect(c["11111111-1111-4111-8111-111111111111"]).toBe(0.123);
    expect(() =>
      setQty({}, "11111111-1111-4111-8111-111111111111", 100000),
    ).toThrow("BAD_QTY");
  });
  it("exposes the cookie name", () => {
    expect(CART_COOKIE).toBe("dada_cart");
  });
});

/**
 * The optimistic client mirror runs on this, so a quantity it paints must be
 * one the cookie would have accepted — and a refused change must leave the
 * mirror showing exactly what the cookie still holds.
 */
describe("trySetQty", () => {
  const A = "11111111-1111-4111-8111-111111111111";

  it("applies what setQty applies", () => {
    expect(trySetQty({}, A, 3)).toEqual({ [A]: 3 });
    expect(trySetQty({ [A]: 3 }, A, 0)).toEqual({});
    expect(trySetQty({ [A]: 3 }, A, 0.1234)).toEqual({ [A]: 0.123 });
  });

  it("returns the cart UNCHANGED where setQty would throw", () => {
    const full: Record<string, number> = {};
    for (let i = 0; i < CART_MAX_LINES; i++) {
      full[`00000000-0000-4000-8000-${String(i).padStart(12, "0")}`] = 1;
    }
    expect(trySetQty(full, A, 1)).toBe(full);
    expect(trySetQty({ [A]: 2 }, A, 100000)).toEqual({ [A]: 2 });
    expect(trySetQty({ [A]: 2 }, A, Number.NaN)).toEqual({ [A]: 2 });
  });

  it("never mutates the cart it was given", () => {
    const before = { [A]: 2 };
    trySetQty(before, A, 9);
    expect(before).toEqual({ [A]: 2 });
  });
});

/**
 * The demand bar's second figure: 件, the units, beside 种, the lines. The
 * float-noise case is the one this function exists for — two weighed lines add
 * up to 0.30000000000000004 in binary floating point, and the bar would print
 * every one of those digits.
 */
describe("cartUnits", () => {
  const A = "11111111-1111-4111-8111-111111111111";
  const B = "22222222-2222-4222-8222-222222222222";

  it("is 0 for an empty cart", () => {
    expect(cartUnits({})).toBe(0);
  });

  it("adds whole quantities up", () => {
    expect(cartUnits({ [A]: 2 })).toBe(2);
    expect(cartUnits({ [A]: 2, [B]: 3 })).toBe(5);
  });

  it("adds fractional (weighed) quantities up", () => {
    expect(cartUnits({ [A]: 0.5, [B]: 0.25 })).toBe(0.75);
  });

  it("rounds the float noise away", () => {
    expect(0.1 + 0.2).not.toBe(0.3); // the reason for the rounding
    expect(cartUnits({ [A]: 0.1, [B]: 0.2 })).toBe(0.3);
    expect(cartUnits({ [A]: 1.005, [B]: 2.115 })).toBe(3.12);
  });
});

/**
 * 再来一单. The whole point of this function is what it REFUSES: the customer's
 * own quantities must survive a reorder, a discontinued article must not come
 * back, and a merge that runs out of room has to say so rather than silently
 * dropping the tail of the order.
 */
describe("mergeReorderLines", () => {
  const A = "11111111-1111-4111-8111-111111111111";
  const B = "22222222-2222-4222-8222-222222222222";
  const C = "33333333-3333-4333-8333-333333333333";
  const all = new Set([A, B, C]);

  it("adds every line of a past order into an empty cart", () => {
    expect(
      mergeReorderLines(
        {},
        [
          { product_id: A, qty: 2 },
          { product_id: B, qty: 0.5 },
        ],
        all,
      ),
    ).toEqual({ cart: { [A]: 2, [B]: 0.5 }, added: 2, skipped: 0 });
  });

  it("leaves a line the customer already has at THEIR quantity", () => {
    const result = mergeReorderLines(
      { [A]: 3 },
      [
        { product_id: A, qty: 12 },
        { product_id: B, qty: 1 },
      ],
      all,
    );
    // The 3 they typed this week, not the 12 they ordered last week.
    expect(result.cart).toEqual({ [A]: 3, [B]: 1 });
    expect(result).toMatchObject({ added: 1, skipped: 1 });
  });

  it("skips a product that is no longer orderable", () => {
    const result = mergeReorderLines(
      {},
      [
        { product_id: A, qty: 1 },
        { product_id: B, qty: 4 },
      ],
      // B is paused, superseded, or gone from the view entirely.
      new Set([A]),
    );
    expect(result).toEqual({ cart: { [A]: 1 }, added: 1, skipped: 1 });
  });

  it("counts the lines a full cart has no room for, and keeps the rest", () => {
    const full: Cart = {};
    for (let i = 0; i < CART_MAX_LINES - 1; i++) {
      full[`00000000-0000-4000-8000-${String(i).padStart(12, "0")}`] = 1;
    }
    // One slot left, three lines wanting it: the first fits, the other two hit
    // CART_FULL inside `setQty` and are reported rather than lost.
    const result = mergeReorderLines(
      full,
      [
        { product_id: A, qty: 1 },
        { product_id: B, qty: 1 },
        { product_id: C, qty: 1 },
      ],
      all,
    );
    expect(Object.keys(result.cart)).toHaveLength(CART_MAX_LINES);
    expect(result.cart[A]).toBe(1);
    expect(result).toMatchObject({ added: 1, skipped: 2 });
  });

  it("normalises a quantity exactly as the cookie would store it", () => {
    // Three decimals, the cookie's own precision — a weighed line ordered at
    // 0.1234 kg comes back as the 0.123 `setQty` would have written.
    expect(mergeReorderLines({}, [{ product_id: A, qty: 0.1234 }], all)).toEqual(
      { cart: { [A]: 0.123 }, added: 1, skipped: 0 },
    );
  });

  it("skips a quantity `setQty` would not store, removal included", () => {
    // 0 and negatives are REMOVALS to `setQty`, so an unguarded merge would
    // delete an unrelated line and report it as added.
    const result = mergeReorderLines(
      { [A]: 4 },
      [
        { product_id: A, qty: 0 },
        { product_id: B, qty: -1 },
        { product_id: C, qty: Number.NaN },
      ],
      all,
    );
    expect(result).toEqual({ cart: { [A]: 4 }, added: 0, skipped: 3 });
    expect(mergeReorderLines({}, [{ product_id: B, qty: 100000 }], all)).toEqual(
      { cart: {}, added: 0, skipped: 1 },
    );
  });

  it("accounts for every line exactly once", () => {
    const lines = [
      { product_id: A, qty: 2 }, // already in the cart
      { product_id: B, qty: 1 }, // added
      { product_id: C, qty: 3 }, // not orderable
      { product_id: A, qty: 9 }, // the same product twice in one order
    ];
    const result = mergeReorderLines({ [A]: 5 }, lines, new Set([A, B]));
    expect(result.added + result.skipped).toBe(lines.length);
    expect(result).toMatchObject({ added: 1, skipped: 3 });
    expect(result.cart).toEqual({ [A]: 5, [B]: 1 });
  });

  it("never mutates the cart it was given", () => {
    const before: Cart = { [A]: 2 };
    mergeReorderLines(before, [{ product_id: B, qty: 1 }], all);
    expect(before).toEqual({ [A]: 2 });
  });

  it("is a no-op for an order with no lines left to copy", () => {
    expect(mergeReorderLines({ [A]: 1 }, [], all)).toEqual({
      cart: { [A]: 1 },
      added: 0,
      skipped: 0,
    });
  });
});

describe("isProductId", () => {
  it("accepts a uuid in either case and rejects anything else", () => {
    expect(isProductId("11111111-1111-4111-8111-111111111111")).toBe(true);
    expect(isProductId("11111111-1111-4111-8111-111111111111".toUpperCase())).toBe(
      true,
    );
    expect(isProductId("")).toBe(false);
    expect(isProductId("__proto__")).toBe(false);
    expect(isProductId("11111111-1111-4111-8111-11111111111")).toBe(false);
    expect(isProductId("x".repeat(4000))).toBe(false);
  });
});
