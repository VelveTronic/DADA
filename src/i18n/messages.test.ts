import { describe, expect, it } from "vitest";
import { ORDER_ERROR_KEYS, ORDER_STATUSES } from "@/lib/orders";
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

  /**
   * Both order pages label a status by indexing this namespace with a value read
   * straight out of the database. A state with no label here reaches a customer
   * as the bare English word from the check constraint.
   */
  it("carries an orders.status label for every state an order can hold", () => {
    const zhStatus: Record<string, string> = zh.orders.status;
    const esStatus: Record<string, string> = es.orders.status;
    for (const status of ORDER_STATUSES) {
      expect(zhStatus[status], `zh orders.status.${status}`).toBeTypeOf(
        "string",
      );
      expect(esStatus[status], `es orders.status.${status}`).toBeTypeOf(
        "string",
      );
    }
  });
});
