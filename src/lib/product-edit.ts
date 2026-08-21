/**
 * The 商品编辑 vocabulary — what one save of a product can come back saying.
 *
 * A plain module and not part of `app/actions/staff-products.ts`, because a
 * `"use server"` file may export nothing but async functions: a const array and
 * a type guard in there is a build error, not a lint opinion. The action
 * redirects with `?result=<CODE>` and the editor page renders
 * `staff.productEdit.results.<CODE>` off it — the same shape the categories,
 * settings and user-admin surfaces already share, and `i18n/messages.test.ts`
 * holds both languages to this list.
 */

export const PRODUCT_EDIT_RESULTS = [
  "ok",
  /** A field arrived malformed — a bad id, a category that is not a number. */
  "BAD_INPUT",
  /** Both name fields empty: a product with no name in either language. */
  "NAME_REQUIRED",
  /** The SKU was blank or longer than the column takes. */
  "CODART_REQUIRED",
  /** Another product already carries that SKU (read, not caught as a 23505). */
  "CODART_TAKEN",
  "IMAGE_TYPE",
  "IMAGE_TOO_LARGE",
  "UPLOAD_FAILED",
  /** The id named no product — a stale tab, or one deleted meanwhile. */
  "NOT_FOUND",
  "DB_ERROR",
] as const;

export type ProductEditResult = (typeof PRODUCT_EDIT_RESULTS)[number];

/** `?result=` is user-editable, so it is proved before it is used as a key. */
export function isProductEditResult(value: string): value is ProductEditResult {
  return (PRODUCT_EDIT_RESULTS as readonly string[]).includes(value);
}
