/**
 * The claim payload and the pure transforms that turn it into injector inputs.
 *
 * Nothing in this module touches a clock, a database, or the filesystem: the
 * whole ERP-facing money and date logic is decided here, in functions a test can
 * pin down exactly, and `injector.ts` is left holding only SQL.
 *
 * Types mirror `bridge_claim_confirmed`'s jsonb rows verbatim (snake_case,
 * because that is what arrives over PostgREST); everything this module PRODUCES
 * is camelCase, so a reader can tell at a glance which side of the wire a value
 * came from.
 */

/** Named validation failure — the job layer logs `code` alongside the order. */
export class PayloadError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "PayloadError";
    this.code = code;
  }
}

/** One `order_items` row as `bridge_claim_confirmed` emits it. */
export interface ClaimedOrderItem {
  codart: string;
  /** CAJAS. numeric(10,3) — fractional for weighed products. */
  qty: number;
  /**
   * Base units per caja, snapshotted on the line when the order was priced.
   *
   * Optional in the TYPE and only in the type: the column is `not null default
   * 1` and the claim RPC always emits it. What can be missing is an order
   * claimed by a bridge that is running while the RPC is being replaced — the
   * lease is minutes long, so a payload from the old shape can still be in
   * flight. `lineParams` defaults that to 1, the factor that changes nothing.
   */
  units_per_case?: number;
  /** Per BASE unit, never per caja — this is the ERP's PREVEN. */
  unit_price_cents: number;
  line_total_cents: number;
  /**
   * Sold by weight: `qty` is kilos rather than a case count.
   *
   * Optional in the TYPE only, exactly as `units_per_case` is: the column is
   * `not null default false` and `bridge_claim_confirmed` has always emitted it.
   * Absent therefore means a malformed payload rather than an old one, and it
   * becomes `false` — the value every line carried before weighed goods existed,
   * and the one that leaves CAJ reading the way it always has.
   */
  is_weighed?: boolean;
  is_erp_excluded: boolean;
}

/** One claimed order as `bridge_claim_confirmed` emits it. */
export interface ClaimedOrder {
  id: string;
  order_number: number;
  claim_token: string;
  delivery_date: string | null;
  customer_note: string | null;
  subtotal_cents: number;
  codcli: number;
  tarcli: number;
  company_name: string;
  items: ClaimedOrderItem[];
}

/** A validated line, carried in BOTH units: cents to add up, euros to store. */
export interface PayloadLine {
  codart: string;
  /** CAJAS, the way the customer ordered — `pedclili.CAJ` unless weighed. */
  qty: number;
  /** Sold by weight: `qty` is kilos, and the injector sends CAJ=0. */
  isWeighed: boolean;
  /** Base units per caja; the injector multiplies to get CANPED/CANSER. */
  unitsPerCase: number;
  unitPriceCents: number;
  lineTotalCents: number;
  /** `pedclili.PREVEN` */
  unitPriceEuros: number;
  /** `pedclili.SUBTOT` and `pedclili.NETO` */
  lineTotalEuros: number;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Integer cents → euros with two exact decimals.
 *
 * Dividing by 100 is the only conversion that is exact for every value the
 * portal can hold: `cents / 100` lands on the nearest double to the true amount,
 * which is the same double `toFixed(2)` prints and the same one SQL Server
 * rounds into a money column. Multiplying by 0.01 would not be.
 */
export function centsToEuros(cents: number): number {
  if (!Number.isInteger(cents)) {
    throw new PayloadError(
      "NOT_INTEGER_CENTS",
      `expected an integer number of cents, got ${cents}`,
    );
  }
  return cents / 100;
}

/**
 * The dedup key AND the "Su Pedido" reference printed on the pedido.
 *
 * The length assert is not defensive noise: NUMPEDCLI is char(30), and SQL
 * Server would SILENTLY truncate a longer value, quietly turning two different
 * portal orders into the same dedup key.
 *
 * `isSafeInteger` rather than `isInteger` because the check above it is the one
 * doing the work: past 2^53 a number stringifies in EXPONENTIAL form
 * ("1.111e+21"), which is both shorter than 30 characters and not the order
 * number — the length assert would wave it through. A postgres `integer`
 * order_number cannot reach that far, so this only ever fires on nonsense.
 */
export function portalRef(orderNumber: number): string {
  if (!Number.isSafeInteger(orderNumber) || orderNumber <= 0) {
    throw new PayloadError(
      "BAD_ORDER_NUMBER",
      `order_number must be a positive safe integer, got ${orderNumber}`,
    );
  }
  const ref = `PORTAL-${orderNumber}`;
  if (ref.length > 30) {
    throw new PayloadError(
      "REF_TOO_LONG",
      `NUMPEDCLI is char(30) and "${ref}" is ${ref.length} characters`,
    );
  }
  return ref;
}

/**
 * `YYYY-MM-DD` that is also a real calendar day. `new Date("2026-02-30")` does
 * NOT throw — it rolls over to 2026-03-02 — so the round-trip comparison is what
 * catches an impossible day before it becomes a delivery date.
 */
function assertIsoDate(value: string, label: string): void {
  if (!ISO_DATE.test(value)) {
    throw new PayloadError(
      "BAD_DATE",
      `${label} must be a YYYY-MM-DD date, got "${value}"`,
    );
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new PayloadError("BAD_DATE", `${label} is not a real calendar date: "${value}"`);
  }
}

/**
 * FECENT for the header and every line: the order's delivery date when it is
 * still reachable, otherwise Madrid today.
 *
 * A pedido dated in the past reads as already-late in the warehouse, and the
 * customer may well have confirmed days before the bridge got to run. The
 * comparison is plain string ordering, which is exactly calendar ordering for
 * zero-padded ISO dates and needs no timezone of its own — `madridToday` was
 * already computed in Madrid by the caller.
 */
export function resolveFecent(
  deliveryDate: string | null | undefined,
  madridToday: string,
): string {
  assertIsoDate(madridToday, "madridToday");
  if (!deliveryDate) return madridToday;
  assertIsoDate(deliveryDate, "delivery_date");
  return deliveryDate >= madridToday ? deliveryDate : madridToday;
}

/**
 * Split the claimed items into the ones the pedido carries and the ones staff
 * will handle by hand. Order is preserved on both sides: NUMLIN follows the
 * customer's cart order, which is what makes a printed pedido readable next to
 * the portal screen.
 */
export function splitLines(items: readonly ClaimedOrderItem[]): {
  included: ClaimedOrderItem[];
  excluded: ClaimedOrderItem[];
} {
  const included: ClaimedOrderItem[] = [];
  const excluded: ClaimedOrderItem[] = [];
  for (const item of items) {
    (item.is_erp_excluded ? excluded : included).push(item);
  }
  return { included, excluded };
}

/**
 * One claimed item → the commercial half of a `pedclili` row.
 *
 * The prices are the PORTAL's, not the ERP's: `create_order` resolved them from
 * the company's tarifa at confirmation time and the customer agreed to them. A
 * fresh `articulo.PREVEN{tier}` read here could be a nightly price-sync away
 * from that. Taxes are the opposite case and are recomputed live in the
 * injector, because tax configuration is ERP truth.
 *
 * Quantities stay in CAJAS here, next to the factor they are multiplied by:
 * this function validates the pair, and `injector.ts` — the only module that
 * knows what Wingest counts — turns it into base units.
 */
export function lineParams(item: ClaimedOrderItem): PayloadLine {
  const codart = item.codart?.trim() ?? "";
  if (!codart) {
    throw new PayloadError("BAD_CODART", "order item has an empty codart");
  }
  if (!Number.isFinite(item.qty) || item.qty <= 0) {
    throw new PayloadError("BAD_QTY", `codart ${codart} has qty ${item.qty}`);
  }
  if (!Number.isInteger(item.unit_price_cents) || item.unit_price_cents < 0) {
    throw new PayloadError(
      "BAD_UNIT_PRICE",
      `codart ${codart} has unit_price_cents ${item.unit_price_cents}`,
    );
  }
  if (!Number.isInteger(item.line_total_cents) || item.line_total_cents < 0) {
    throw new PayloadError(
      "BAD_LINE_TOTAL",
      `codart ${codart} has line_total_cents ${item.line_total_cents}`,
    );
  }
  // Absent means "claimed before the RPC learned to send it" (see the field's
  // comment) and becomes 1 — the factor a line placed before Task 1 really
  // carried, and the one value that multiplies nothing. It is never GUESSED:
  // if the portal priced a caja of 24 and this defaulted to 1, the base units
  // would come out 24x short of what the customer paid for, which is precisely
  // what the injector's SUBTOT contract check refuses to commit.
  const unitsPerCase = item.units_per_case ?? 1;
  if (!Number.isInteger(unitsPerCase) || unitsPerCase < 1) {
    throw new PayloadError(
      "BAD_UNITS_PER_CASE",
      `codart ${codart} has units_per_case ${item.units_per_case}`,
    );
  }
  // Absent is the documented default; anything that is not a boolean is a
  // payload this bridge does not understand, and guessing which way it meant
  // would decide whether CAJ says 5 cajas or 0 on a 5.2 kg line.
  if (item.is_weighed !== undefined && typeof item.is_weighed !== "boolean") {
    throw new PayloadError(
      "BAD_WEIGHED",
      `codart ${codart} has a non-boolean is_weighed ${JSON.stringify(item.is_weighed)}`,
    );
  }
  const isWeighed = item.is_weighed ?? false;
  // A fraction of a caja is not a thing that can be picked, packed or converted,
  // and no write path in the portal can produce one: `create_order` and
  // `staff_update_order_line` both raise BAD_QTY_STEP for a fractional quantity
  // on a product nobody has flagged as weighed. A claim carrying one means the
  // row was changed by something other than those two, so this order fails
  // cleanly and loudly here instead of being silently truncated into a CAJ the
  // customer never ordered.
  if (!isWeighed && !Number.isInteger(item.qty)) {
    throw new PayloadError(
      "BAD_QTY_STEP",
      `codart ${codart} is not weighed but has fractional qty ${item.qty}`,
    );
  }
  return {
    codart,
    qty: item.qty,
    isWeighed,
    unitsPerCase,
    unitPriceCents: item.unit_price_cents,
    lineTotalCents: item.line_total_cents,
    unitPriceEuros: centsToEuros(item.unit_price_cents),
    lineTotalEuros: centsToEuros(item.line_total_cents),
  };
}
