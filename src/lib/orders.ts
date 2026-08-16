/**
 * Order-side helpers shared by the cart page, the checkout action and the two
 * order pages. Pure, no I/O: the delivery-date window, the `create_order` error
 * map and the status vocabulary are the places where a silent mistake would
 * either block a valid order or show a customer nothing but "try again".
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

/**
 * Every state `orders_status_check` allows, in the order an order moves through
 * them. `processing` is the bridge's own claim state — `bridge_claim_confirmed`
 * sets it and `bridge_mark_injected` moves it on — and it is as visible to a
 * customer as any other, so it carries a label like the rest.
 */
export type OrderStatus =
  | "submitted"
  | "confirmed"
  | "processing"
  | "injected"
  | "albaran"
  | "cancelled";

export const ORDER_STATUSES: readonly OrderStatus[] = [
  "submitted",
  "confirmed",
  "processing",
  "injected",
  "albaran",
  "cancelled",
];

/**
 * `orders.status` is `text` to the type generator, so every page reads it as a
 * plain string. Guarding it before it indexes `orders.status.<key>` keeps a
 * state this build has never heard of from throwing at a customer mid-page.
 */
export function isOrderStatus(value: string): value is OrderStatus {
  return ORDER_STATUSES.some((status) => status === value);
}

/** The three views the staff queue offers; `all` means "no status filter". */
export const QUEUE_TABS = ["submitted", "confirmed", "all"] as const;

export type QueueTab = (typeof QUEUE_TABS)[number];

/**
 * `?estado=` is user-editable and reaches `.eq("status", …)`, so it is checked
 * against the tabs the queue actually offers rather than against the status
 * list: `injected` is a real status and still not a view this page has.
 */
export function safeQueueTab(value: string | null | undefined): QueueTab {
  return QUEUE_TABS.find((tab) => tab === value) ?? "submitted";
}

/**
 * `?created=` survives the checkout redirect and goes straight into the success
 * banner, so it is a plain order number or nothing at all — digits only, and
 * short enough to be a value of a sequence that starts at 1001.
 */
export function parseOrderNumber(value: string | null | undefined): number | null {
  if (typeof value !== "string" || !/^\d{1,9}$/.test(value)) return null;
  const parsed = Number(value);
  return parsed > 0 ? parsed : null;
}

/**
 * The dates an order carries, rendered for a locale on Madrid's calendar.
 *
 * The two columns are different animals and the format has to know which it
 * has. `delivery_date` is a `date`: no time and no zone, so "2026-08-16" parses
 * as UTC midnight and, formatted in any zone behind UTC, would come back out as
 * the 15th — it is pinned to UTC. `created_at` is a `timestamptz` and formats in
 * Europe/Madrid, the same calendar `madridDay` judges the delivery window on, so
 * the two dates in a row can never disagree about what day it is.
 */
export function formatOrderDate(value: string, locale: string): string {
  const plainDay = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const date = new Date(plainDay ? `${value}T00:00:00Z` : value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "es-ES", {
    timeZone: plainDay ? "UTC" : "Europe/Madrid",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
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

/**
 * The cart cookie's own per-line cap, restated for the staff queue's editor.
 *
 * `staff_update_order_line` does NOT enforce this one — it enforces exactly what
 * `create_order` enforces, and neither of them has ever known about a number a
 * COOKIE could not hold. It is here so the queue refuses, in words, the quantity
 * the cart page would have refused silently: a staff member correcting 3 cajas to
 * 2 has no business typing 40,000, and a stray keypress that produces one should
 * come back as "revise la cantidad" rather than as a €400,000 pedido.
 */
export const MAX_LINE_QTY = 9999;

/**
 * Is this a quantity a line may hold? `null` when it is.
 *
 * The two codes are `create_order`'s and `staff_update_order_line`'s, deliberately
 * — this is the same question asked one round trip earlier, so a staff member who
 * sees BAD_QTY_STEP here is reading the sentence the RPC would have sent back.
 *
 * `isWeighed` is the ONE thing this function cannot be told by a form. The RPC
 * re-reads it from the product at call time and is the authority; the queue passes
 * what it rendered the row with, and the action passes `true` — the permissive
 * branch — so that the integer rule is decided once, by the side that actually
 * knows. Everything else (finite, positive, ≤ 3 decimals, under the cap) is the
 * same answer wherever it is asked.
 *
 * Three decimals are checked the way the cart rounds them (`× 1000`, round, back)
 * rather than by counting characters: the caller has a `number`, and 5.2 is not
 * exactly 5.2 in binary — but `Math.round(5.2 * 1000) / 1000` is exactly the 5.2
 * it started from, while 0.1234 is not.
 */
export function validateLineQty(
  qty: number,
  isWeighed: boolean,
): "BAD_QTY" | "BAD_QTY_STEP" | null {
  if (!Number.isFinite(qty) || qty <= 0 || qty > MAX_LINE_QTY) return "BAD_QTY";
  if (Math.round(qty * 1000) / 1000 !== qty) return "BAD_QTY";
  if (!isWeighed && !Number.isInteger(qty)) return "BAD_QTY_STEP";
  return null;
}

/**
 * Every outcome the queue's line editor reports, as it travels back in
 * `?lineResult=` and indexes `staff.lineResults.*`.
 *
 * `WRONG_STATE` is `staff_update_order_line` returning `false`: the order was
 * confirmed or cancelled by somebody else while this page was open, and the edit
 * did NOT apply. It is the one outcome that is neither a success nor a fault, and
 * it is reported rather than assumed away — the same contract the confirm and
 * cancel buttons already have.
 */
export const LINE_EDIT_RESULTS = [
  "ok",
  "WRONG_STATE",
  "BAD_LINE",
  "BAD_QTY",
  "BAD_QTY_STEP",
  "DB_ERROR",
] as const;

export type LineEditResult = (typeof LINE_EDIT_RESULTS)[number];

/** Guards `?lineResult=` on the way back in: the query string is user-editable. */
export function isLineEditResult(value: string): value is LineEditResult {
  return LINE_EDIT_RESULTS.some((result) => result === value);
}

/**
 * The codes `staff_update_order_line` RAISES — `BAD_QTY_STEP` with the codart
 * appended, as `create_order` does it. `ok` and `WRONG_STATE` are not among them
 * on purpose: neither is ever an exception, so a Postgres message that happened
 * to read "WRONG_STATE" must not be able to redraw a failed edit as a handled one.
 */
const LINE_EDIT_RAISED: readonly LineEditResult[] = [
  "BAD_LINE",
  "BAD_QTY",
  "BAD_QTY_STEP",
];

/**
 * Map a Postgres error message onto a line-editor result. Anything the RPC did
 * not raise — a revoked grant, a lost connection, `integer out of range` from a
 * line total that does not fit its column — is DB_ERROR: the edit did not happen
 * and nothing more specific can honestly be said about why.
 */
export function mapLineEditError(
  message: string | null | undefined,
): LineEditResult {
  const raw = String(message ?? "");
  const colon = raw.indexOf(":");
  const code = (colon === -1 ? raw : raw.slice(0, colon)).trim();
  return LINE_EDIT_RAISED.find((result) => result === code) ?? "DB_ERROR";
}
