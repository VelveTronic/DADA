import { describe, expect, it } from "vitest";
import { CATEGORY_ERRORS } from "@/lib/categories";
import {
  CUSTOMER_ORDER_TABS,
  LINE_EDIT_RESULTS,
  ORDER_ERROR_KEYS,
  ORDER_STATUSES,
} from "@/lib/orders";
import { PROFILE_ERRORS } from "@/lib/profile";
import { SETTING_KEYS, SETTINGS_ERRORS } from "@/lib/settings";
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
   * The category surface answers the same way: the row actions redirect with
   * `?result=<CODE>` and `/staff/categorias` renders
   * `staff.categories.results.<CODE>`, while a rejected create hands the same
   * code to its form to draw inline. A code with no message here arrives as the
   * raw SCREAMING_SNAKE token beside the buttons that reorder every
   * restaurant's category rail.
   */
  it("carries a staff.categories.results message for every category outcome", () => {
    const zhResults: Record<string, string> = zh.staff.categories.results;
    const esResults: Record<string, string> = es.staff.categories.results;
    for (const key of [...CATEGORY_ERRORS, "ok"]) {
      expect(zhResults[key], `zh staff.categories.results.${key}`).toBeTypeOf(
        "string",
      );
      expect(esResults[key], `es staff.categories.results.${key}`).toBeTypeOf(
        "string",
      );
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

  /**
   * Every switch on /staff/ajustes needs a label and a hint in both languages.
   * The registry key is snake_case and the message key is its camelCase twin
   * (`show_delivery_date` → `showDeliveryDate` + `showDeliveryDateHint`), so
   * adding a setting without writing its strings fails HERE — rather than
   * drawing the raw `staff.settings.showWhatever` token on the owner's page,
   * next to a switch that changes what every restaurant sees.
   */
  it("carries a label and a hint for every registered setting", () => {
    const camel = (key: string) =>
      key.replace(/_(.)/g, (_, char: string) => char.toUpperCase());
    const zhSettings: Record<string, unknown> = zh.staff.settings;
    const esSettings: Record<string, unknown> = es.staff.settings;
    for (const key of SETTING_KEYS) {
      const label = camel(key);
      expect(zhSettings[label], `zh staff.settings.${label}`).toBeTypeOf("string");
      expect(esSettings[label], `es staff.settings.${label}`).toBeTypeOf("string");
      expect(zhSettings[`${label}Hint`], `zh staff.settings.${label}Hint`).toBeTypeOf("string");
      expect(esSettings[`${label}Hint`], `es staff.settings.${label}Hint`).toBeTypeOf("string");
    }
  });

  /**
   * `updateDisplayName` and `changePassword` redirect with `?name=<CODE>` /
   * `?pwd=<CODE>` and `/perfil` draws `profile.results.<CODE>` off whichever
   * arrived. A code with no message here reaches a restaurant as the raw
   * SCREAMING_SNAKE token in the middle of changing their own password.
   */
  it("carries a profile.results message for every profile outcome", () => {
    const zhResults: Record<string, string> = zh.profile.results;
    const esResults: Record<string, string> = es.profile.results;
    for (const key of [...PROFILE_ERRORS, "ok"]) {
      expect(zhResults[key], `zh profile.results.${key}`).toBeTypeOf("string");
      expect(esResults[key], `es profile.results.${key}`).toBeTypeOf("string");
    }
  });

  /**
   * `updateOrderLineQty` redirects with `?lineResult=<CODE>` and the queue draws
   * `staff.lineResults.<CODE>` off it. A code with no message here reaches a
   * staff member as the raw token while they are correcting the weight on an
   * order that is about to be injected into Wingest.
   */
  it("carries a staff.lineResults message for every line-edit outcome", () => {
    const zhResults: Record<string, string> = zh.staff.lineResults;
    const esResults: Record<string, string> = es.staff.lineResults;
    for (const key of LINE_EDIT_RESULTS) {
      expect(zhResults[key], `zh staff.lineResults.${key}`).toBeTypeOf("string");
      expect(esResults[key], `es staff.lineResults.${key}`).toBeTypeOf("string");
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

  /**
   * The history's chip row draws one label per tab in `CUSTOMER_ORDER_TABS`.
   * Adding a fifth view without writing its two strings would put the raw
   * `orders.tabWhatever` token on a chip in front of a restaurant.
   */
  it("carries a label for every customer order tab", () => {
    const camel = (tab: string) => `tab${tab[0].toUpperCase()}${tab.slice(1)}`;
    const zhOrders: Record<string, unknown> = zh.orders;
    const esOrders: Record<string, unknown> = es.orders;
    for (const tab of CUSTOMER_ORDER_TABS) {
      expect(zhOrders[camel(tab)], `zh orders.${camel(tab)}`).toBeTypeOf(
        "string",
      );
      expect(esOrders[camel(tab)], `es orders.${camel(tab)}`).toBeTypeOf(
        "string",
      );
    }
  });

  it("labels every bridge-card state, including completed runs with business failures", () => {
    const states = [
      "ok",
      "busy",
      "degraded",
      "businessFailed",
      "failed",
      "stale",
      "missing",
    ] as const;
    for (const key of states) {
      expect(zh.staff.bridge.state[key]).toBeTypeOf("string");
      expect(es.staff.bridge.state[key]).toBeTypeOf("string");
      if (key !== "ok") {
        expect(zh.staff.bridge.hint[key]).toBeTypeOf("string");
        expect(es.staff.bridge.hint[key]).toBeTypeOf("string");
      }
    }
  });

  it("labels the persistent order-backlog counters in both languages", () => {
    const counters = [
      "manualRequired",
      "retryPending",
      "processingPending",
      "backlogCountError",
    ] as const;
    for (const key of counters) {
      expect(zh.staff.bridge.counts.orders[key]).toBeTypeOf("string");
      expect(es.staff.bridge.counts.orders[key]).toBeTypeOf("string");
    }
  });
});
