import { describe, expect, it } from "vitest";
import { ORDER_ERROR_KEYS } from "@/lib/orders";
import es from "../../messages/es.json";
import zh from "../../messages/zh.json";

function leafKeys(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null) return [prefix];
  return Object.entries(value).flatMap(([key, child]) =>
    leafKeys(child, prefix ? `${prefix}.${key}` : key),
  );
}

describe("translations", () => {
  it("keeps Spanish and Chinese message keys aligned", () => {
    expect(leafKeys(es).sort()).toEqual(leafKeys(zh).sort());
  });

  /**
   * The checkout action maps every create_order failure onto one of these keys
   * and the cart page renders `errors.<key>` off it. Renaming one in the JSON
   * has to break here, not throw at a customer mid-order.
   */
  it("carries a cart.errors message for every create_order failure", () => {
    const zhErrors: Record<string, string> = zh.cart.errors;
    const esErrors: Record<string, string> = es.cart.errors;
    for (const key of ORDER_ERROR_KEYS) {
      expect(zhErrors[key], `zh cart.errors.${key}`).toBeTypeOf("string");
      expect(esErrors[key], `es cart.errors.${key}`).toBeTypeOf("string");
    }
  });
});
