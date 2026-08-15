import type { Database } from "./database.types";

/** Customer-safe product projection. Never replace this with products.Row. */
export type CustomerCatalogProduct =
  Database["public"]["Views"]["products_priced"]["Row"];

/** Public order fields available to an authenticated customer or staff client. */
export type PublicOrder = Pick<
  Database["public"]["Tables"]["orders"]["Row"],
  | "id"
  | "order_number"
  | "company_id"
  | "placed_by"
  | "status"
  | "delivery_date"
  | "customer_note"
  | "subtotal_cents"
  | "numped"
  | "numalb"
  | "created_at"
  | "confirmed_at"
  | "injected_at"
  | "albaran_at"
  | "updated_at"
>;

/**
 * `PublicOrder` as a PostgREST select list — the runtime twin of the type above,
 * and the only column list any customer or staff page should send.
 *
 * It lives here because TypeScript cannot police this. `staff_note` is
 * column-revoked from authenticated, so naming it — or `*`, which names
 * everything — fails the WHOLE query with a 403 instead of dropping the one
 * column; and a query that asked for one column too many still satisfies a
 * narrower row type, so the mistake type-checks clean and only shows up as an
 * empty page. One list, next to the type it mirrors, is one place to get right.
 */
export const PUBLIC_ORDER_COLUMNS =
  "id, order_number, company_id, placed_by, status, delivery_date, customer_note, subtotal_cents, numped, numalb, created_at, confirmed_at, injected_at, albaran_at, updated_at";
