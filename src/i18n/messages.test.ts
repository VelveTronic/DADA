import { describe, expect, it } from "vitest";
import { ORDER_ERROR_KEYS, ORDER_STATUSES } from "@/lib/orders";
import { SETTINGS_ERRORS } from "@/lib/settings";
import { STAFF_ROLES, USER_ADMIN_ERRORS } from "@/lib/user-admin";
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
   * Every user-admin outcome reaches the staff member through this namespace:
   * the row actions redirect with `?result=<CODE>` and the page renders
   * `staff.users.results.<CODE>`, while a rejected create hands the same code
   * to its form to draw inline. A code with no message here arrives as a
   * next-intl fallback — the raw SCREAMING SNAKE token — in the middle of
   * creating somebody's account.
   */
  it("carries a staff.users.results message for every user-admin outcome", () => {
    const zhResults: Record<string, string> = zh.staff.users.results;
    const esResults: Record<string, string> = es.staff.users.results;
    for (const key of [...USER_ADMIN_ERRORS, "ok"]) {
      expect(zhResults[key], `zh staff.users.results.${key}`).toBeTypeOf("string");
      expect(esResults[key], `es staff.users.results.${key}`).toBeTypeOf("string");
    }
  });

  /**
   * `updateSetting` redirects with `?result=<CODE>` and `/staff/ajustes` renders
   * `staff.settings.results.<CODE>` off it, exactly as the user-admin page does.
   * A code with no message here reaches the owner as the raw token in the middle
   * of changing what every restaurant sees.
   */
  it("carries a staff.settings.results message for every settings outcome", () => {
    const zhResults: Record<string, string> = zh.staff.settings.results;
    const esResults: Record<string, string> = es.staff.settings.results;
    for (const key of [...SETTINGS_ERRORS, "ok"]) {
      expect(zhResults[key], `zh staff.settings.results.${key}`).toBeTypeOf("string");
      expect(esResults[key], `es staff.settings.results.${key}`).toBeTypeOf("string");
    }
  });

  /** The role `<select>` and every staff row label a role read from the column. */
  it("carries a staff.users.roles label for each of the three roles", () => {
    const zhRoles: Record<string, string> = zh.staff.users.roles;
    const esRoles: Record<string, string> = es.staff.users.roles;
    for (const role of STAFF_ROLES) {
      expect(zhRoles[role], `zh staff.users.roles.${role}`).toBeTypeOf("string");
      expect(esRoles[role], `es staff.users.roles.${role}`).toBeTypeOf("string");
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
