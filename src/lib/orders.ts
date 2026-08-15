/**
 * Order-side helpers shared by the cart page and the checkout action. Pure, no
 * I/O: the delivery-date window and the `create_order` error map are exactly the
 * two places where a silent mistake would either block a valid order or show a
 * customer nothing but "try again".
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `p_client_token` is a uuid column; anything else would be a cast error. */
export function isUuid(value: string): boolean {
  return UUID.test(value);
}

/**
 * The civil day in Madrid as `YYYY-MM-DD` — the calendar `create_order` judges a
 * delivery date against (`now() at time zone 'Europe/Madrid'`). `en-CA` is the
 * locale whose short date format IS ISO, so no reassembly is needed.
 */
export function madridDay(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Madrid",
  }).format(now);
}

/**
 * Calendar-day arithmetic on a `YYYY-MM-DD` string, done in UTC so an offset
 * change (Madrid's spring-forward lands inside the 60-day window every March)
 * can never round a day away. Postgres `date + 60` counts calendar days too, so
 * the input the page offers and the range the RPC enforces stay identical.
 */
export function addDays(day: string, days: number): string {
  const [year, month, date] = day.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, date) + days * 86_400_000);
  return shifted.toISOString().slice(0, 10);
}

/** Every `create_order` failure a customer gets a written explanation for. */
export type OrderErrorKey =
  | "NO_ACTIVE_COMPANY"
  | "COMPANY_NOT_LINKED"
  | "EMPTY_ORDER"
  | "TOO_MANY_LINES"
  | "NOTE_TOO_LONG"
  | "BAD_DELIVERY_DATE"
  | "BAD_QTY"
  | "BAD_QTY_STEP"
  | "PRODUCT_UNAVAILABLE"
  | "NO_PRICE"
  | "UNKNOWN";

export const ORDER_ERROR_KEYS: readonly OrderErrorKey[] = [
  "NO_ACTIVE_COMPANY",
  "COMPANY_NOT_LINKED",
  "EMPTY_ORDER",
  "TOO_MANY_LINES",
  "NOTE_TOO_LONG",
  "BAD_DELIVERY_DATE",
  "BAD_QTY",
  "BAD_QTY_STEP",
  "PRODUCT_UNAVAILABLE",
  "NO_PRICE",
  "UNKNOWN",
];

/** Guards `?error=` on the way back in: the query string is user-editable. */
export function isOrderErrorKey(value: string): value is OrderErrorKey {
  return ORDER_ERROR_KEYS.some((key) => key === value);
}

/**
 * A detail worth putting in front of a customer: a codart they can match against
 * a line of their own cart. `PRODUCT_UNAVAILABLE` carries the product's internal
 * uuid instead — 36 characters that mean nothing to a restaurant — so it fails
 * this test and the banner falls back to its own "remove it" wording. Guarding
 * the value on the way back out of the URL as well keeps a crafted link from
 * putting arbitrary text on the page.
 */
export function isOrderErrorDetail(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._/-]{0,23}$/.test(value);
}

/**
 * Map a Postgres error message onto a `cart.errors.*` key. `create_order` raises
 * bare codes, three of them with a detail appended after a colon
 * (`NO_PRICE:<codart>:tier N`), so the code is everything before the FIRST colon
 * and the detail is the segment after it.
 *
 * Codes with no message of their own (`BAD_LINE`, `IDEMPOTENCY_MISMATCH`) land
 * on UNKNOWN deliberately: both mean "this submission is malformed, start again
 * from the cart", which is what UNKNOWN already says — and a re-rendered cart
 * carries a fresh client_token, which is the actual fix for the second one.
 */
export function mapOrderError(message: string | null | undefined): {
  key: OrderErrorKey;
  detail: string | null;
} {
  const raw = String(message ?? "");
  const colon = raw.indexOf(":");
  const code = (colon === -1 ? raw : raw.slice(0, colon)).trim();
  const key: OrderErrorKey = isOrderErrorKey(code) ? code : "UNKNOWN";

  // A detail only ever accompanies a code we recognise. An unmapped Postgres
  // message is not ours to quote: `permission denied for table orders` splits on
  // its own colon into a fragment that passes the codart test, and would then be
  // glued onto "try again later" on the customer's cart page.
  if (colon === -1 || key === "UNKNOWN") return { key, detail: null };
  const candidate = raw.slice(colon + 1).split(":")[0].trim();
  return { key, detail: isOrderErrorDetail(candidate) ? candidate : null };
}
