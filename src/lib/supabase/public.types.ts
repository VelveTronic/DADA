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
