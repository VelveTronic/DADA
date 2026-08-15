import { describe, expect, it } from "vitest";
import {
  CART_COOKIE,
  CART_MAX_LINES,
  isProductId,
  parseCart,
  serializeCart,
  setQty,
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
