/**
 * The injector: one confirmed portal order → one Wingest **Pedido**.
 *
 * This is a port of the sandbox-validated PowerShell injector v3.2 — the script
 * that produced a pedido Wingest's own conversion engine turned into an albarán
 * with correct stock movements. Every column, every counter trick and every
 * pre-commit self-check below is traceable to that script; where this file
 * departs from it, the departure is one of Plan 04's six deltas or is called out
 * in a comment naming what the reference did and why we do otherwise.
 *
 * Three rules govern the SQL in this file:
 *
 * 1. **No value is ever interpolated.** The reference builds SQL with PowerShell
 *    string interpolation; here every value — config, payload or ERP-derived —
 *    is a typed `mssql` parameter. The only literals inside a SQL string are
 *    schema constants (table names, column names, `ELEMENTO='IDVENTA'`,
 *    `ESTPED='Abierto'`), which are as fixed as the column names beside them.
 * 2. **Parameter types mirror the reference's wire types.** PowerShell's
 *    `AddWithValue` infers SqlDbType from the .NET type: `[double]` → Float,
 *    `[string]` → NVarChar, `[int]` → Int, `[long]` → BigInt, `[datetime]` →
 *    DateTime. Reproducing that is the point — the reference's output is the
 *    only evidence we have of what Wingest accepts. Lengths are left to the
 *    driver to infer from the value, exactly as `AddWithValue` does.
 * 3. **Business dates come from SQL Server in Madrid time.** The ERP server's OS
 *    clock is set to China time, so `GETDATE()`'s DATE is routinely a day ahead
 *    of the business day. `MADRID_TODAY_SQL` is used everywhere the reference
 *    used `CAST(GETDATE() AS date)`.
 *
 *    `GETDATE()` deliberately survives in exactly three places, all of which ask
 *    for a MOMENT rather than a business day, and none of which should be
 *    "fixed" during a timezone incident:
 *      - `pedclica.TS` and `pedclica.TSENVSRV` — audit instants;
 *      - `pickLot`'s expiry predicate (`s.FECCAD>GETDATE()`) — "has this lot
 *        expired *now*", where the hours between the server's zone and Madrid
 *        can only matter for a lot expiring within those same hours.
 */
import * as sql from "mssql";
import { wingestPoolConfig, type BridgeConfig } from "./config";
import {
  centsToEuros,
  lineParams,
  portalRef,
  resolveFecent,
  splitLines,
  type ClaimedOrder,
} from "./payload";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Every failure the injector reports, always carrying the order it happened on:
 * a bridge log line without the order number is an alert nobody can action.
 */
export class InjectError extends Error {
  readonly code: string;
  readonly orderId: string;
  readonly orderNumber: number;
  readonly ref: string;

  constructor(
    code: string,
    message: string,
    context: { orderId: string; orderNumber: number; ref: string },
    options?: ErrorOptions,
  ) {
    super(
      `order ${context.orderNumber} (${context.ref}): ${message}`,
      options,
    );
    this.name = "InjectError";
    this.code = code;
    this.orderId = context.orderId;
    this.orderNumber = context.orderNumber;
    this.ref = context.ref;
  }
}

/**
 * Every line on the order is `is_erp_excluded`, so there is no pedido to write.
 * Its own class because the job layer treats it differently from a failure: the
 * order is left `processing`, the lease expires, and staff pick it up by hand.
 */
export class AllLinesExcludedError extends InjectError {
  constructor(context: { orderId: string; orderNumber: number; ref: string }) {
    super(
      ALL_LINES_EXCLUDED,
      "every line is is_erp_excluded — nothing to inject",
      context,
    );
    this.name = "AllLinesExcludedError";
  }
}

export const ALL_LINES_EXCLUDED = "ALL_LINES_EXCLUDED";

// ---------------------------------------------------------------------------
// SQL fragments and the two INSERT statements
// ---------------------------------------------------------------------------

/**
 * Madrid's Windows timezone key. `AT TIME ZONE` resolves DST for the actual
 * date, which a fixed `+01:00` offset would not.
 */
export const MADRID_TODAY_SQL =
  "CAST(SYSDATETIMEOFFSET() AT TIME ZONE 'Romance Standard Time' AS date)";

/** `[column, valueExpression]` — the pairing a reviewer diffs against v3.2. */
export type ColumnValue = readonly [column: string, value: string];

/**
 * `pedclica`, the pedido header. Column order and value expressions are v3.2's,
 * with Plan-04 delta 1 applied to the five date expressions:
 *
 * - FECPED, FECPREVTO, fecalt: `CAST(GETDATE() AS date)` → `MADRID_TODAY_SQL`
 * - SEMANA: `DATEPART(week,GETDATE())` → the same week, of the Madrid date
 *   (SEMANA is the business week of FECPED; leaving it on the China clock would
 *   put a Sunday-evening Madrid order into next week)
 * - FECENT: `CAST(GETDATE() AS date)` → `@FECENT`, resolved by `resolveFecent`
 *
 * TS and TSENVSRV keep `GETDATE()`: they are audit instants, not business days.
 */
export const PEDCLICA_COLUMNS: readonly ColumnValue[] = [
  ["CAN", "@CAN"],
  ["EJE", "@EJE"],
  ["NUMPED", "@NUMPED"],
  ["FECPED", MADRID_TODAY_SQL],
  ["FECENT", "@FECENT"],
  ["NUMPEDCLI", "@EXT"],
  ["CODCLI", "@CODCLI"],
  ["IMPBAS1", "@B1"],
  ["IMPBAS2", "@B2"],
  ["IMPBAS3", "@B3"],
  ["IMPBAS4", "@B4"],
  ["IMPBAS5", "@B5"],
  ["TPCIVA1", "@T1"],
  ["TPCIVA2", "@T2"],
  ["TPCIVA3", "@T3"],
  ["TPCIVA4", "@T4"],
  ["TPCIVA5", "@T5"],
  ["IMPIVA1", "@I1"],
  ["IMPIVA2", "@I2"],
  ["IMPIVA3", "@I3"],
  ["IMPIVA4", "@I4"],
  ["IMPIVA5", "@I5"],
  ["ESIMPBAS1", "@E1"],
  ["ESIMPBAS2", "@E2"],
  ["ESIMPBAS3", "@E3"],
  ["ESIMPBAS4", "@E4"],
  ["TOTPED", "@TOT"],
  ["NETO", "@NETO"],
  ["TOTCOS", "@TOTCOS"],
  ["FORPAG", "@FORPAG"],
  ["PRIPAG", "@PRIPAG"],
  ["NUMPAG", "@NUMPAG"],
  ["TIPIVACLI", "@TIPIVACLI"],
  ["CALENV", "@CALENV"],
  ["CODPOSENV", "@CPENV"],
  ["calenv2", "@CAL2"],
  ["TIPPOR", "@TIPPOR"],
  ["COMUNICA", "'0'"],
  ["ULTVAL", "1"],
  ["TARCLI", "@TARCLI"],
  ["ULTLIN", "@ULTLIN"],
  ["ESTPED", "'Abierto'"],
  ["ALBARAN", "0"],
  ["ACTALB", "0"],
  ["SERFAC", "@SERFAC"],
  ["regiva", "@REGIVA"],
  ["IRPFBASTOT", "1"],
  ["IMPBASIRPF", "@NETO"],
  ["idventa", "@IDVENTA"],
  ["USUCREPED", "@USU"],
  ["CODUSU", "@USU"],
  ["FECPREVTO", MADRID_TODAY_SQL],
  ["TSENVSRV", "GETDATE()"],
  ["TS", "GETDATE()"],
  ["fecalt", MADRID_TODAY_SQL],
  ["SEMANA", `DATEPART(week,${MADRID_TODAY_SQL})`],
];

/**
 * `pedclili`, one row per included line. v3.2 verbatim except FECENT, which
 * follows the header's (delta 1). `CANSER=CANPED` is the load-bearing one: it is
 * what makes every line servible, which is what the conversion to albarán needs.
 *
 * The STATEMENT is unchanged by the caja decision — what changed is what two of
 * its parameters carry. DEVIATION, owner's decision of **2026-08-16**: a portal
 * quantity means CAJAS, so `@QTY` (CANPED/CANSER) is now `qty x units_per_case`
 * in BASE units and `@CAJ` is the case count itself. Before it, injected albarán
 * 5992 read `CAJ=1, CANSER=2` for two cajas — the case count in the quantity
 * column and a 1 in the case column — while the same line hand-written by staff
 * reads `CAJ=5, CANSER=120, PREVEN=0.99`. `@PRE` is untouched: PREVEN was always
 * the per-BASE-unit price, which is exactly what the portal stores.
 */
export const PEDCLILI_COLUMNS: readonly ColumnValue[] = [
  ["CAN", "@CAN"],
  ["EJE", "@EJE"],
  ["NUMPED", "@NUMPED"],
  ["NUMLIN", "@NUMLIN"],
  ["CODART", "@COD"],
  ["CANPED", "@QTY"],
  ["CANSER", "@QTY"],
  ["PREVEN", "@PRE"],
  ["PRECOS", "@PRECOS"],
  ["DESMOD", "@DES"],
  ["SUBTOT", "@SUB"],
  ["NETO", "@SUB"],
  ["CODALM", "@ALM"],
  ["TIPIVAART", "@T"],
  ["unidad", "@UNI"],
  ["UNILOT", "@UNILOT"],
  ["CAJ", "@CAJ"],
  ["CODLOT", "@LOT"],
  ["FECCAD", "@FCAD"],
  ["FECENT", "@FECENT"],
  ["CODCLI", "@CODCLI"],
  ["idlinea", "@IDL"],
  ["COMUNICA", "''"],
];

/** `table` is only ever a literal at the call site — never a value. */
export function buildInsertSql(table: string, columns: readonly ColumnValue[]): string {
  const names = columns.map(([column]) => column).join(",");
  const values = columns.map(([, value]) => value).join(",");
  return `INSERT INTO ${table} (${names}) VALUES (${values})`;
}

export const PEDCLICA_INSERT_SQL = buildInsertSql("pedclica", PEDCLICA_COLUMNS);
export const PEDCLILI_INSERT_SQL = buildInsertSql("pedclili", PEDCLILI_COLUMNS);

// ---------------------------------------------------------------------------
// Parameter plumbing
// ---------------------------------------------------------------------------

export interface Param {
  type: sql.ISqlType | (() => sql.ISqlType);
  value: unknown;
}
export type ParamMap = Record<string, Param>;

/**
 * Parameter constructors named for the .NET type the reference passed, so a
 * reviewer can check the wire type against `AddWithValue`'s inference without
 * leaving this file.
 */
export const P = {
  /** `[int]` → SqlDbType.Int */
  int: (value: number): Param => ({ type: sql.Int, value }),
  /** `[long]` → SqlDbType.BigInt */
  bigint: (value: number): Param => ({ type: sql.BigInt, value }),
  /** `[double]` → SqlDbType.Float */
  float: (value: number): Param => ({ type: sql.Float, value }),
  /** `[string]` → SqlDbType.NVarChar */
  text: (value: string): Param => ({ type: sql.NVarChar, value }),
  /** No reference equivalent: a pure business day, never a moment. */
  date: (value: Date): Param => ({ type: sql.Date, value }),
  /** `[datetime]` → SqlDbType.DateTime */
  datetime: (value: Date): Param => ({ type: sql.DateTime, value }),
} as const;

export function applyParams(request: sql.Request, params: ParamMap): void {
  for (const [name, param] of Object.entries(params)) {
    request.input(name, param.type, param.value);
  }
}

/** Anything that can hand out a `Request`: the pool, or a transaction on it. */
export interface SqlParent {
  request(): sql.Request;
}

async function runQuery<T = Record<string, unknown>>(
  parent: SqlParent,
  text: string,
  params: ParamMap = {},
): Promise<sql.IResult<T>> {
  const request = parent.request();
  applyParams(request, params);
  return request.query<T>(text);
}

/**
 * The first column of the first row, whatever it is called. Every scalar query
 * below selects exactly one value, so naming the column would only be one more
 * string to keep in sync with the SQL beside it.
 */
function firstScalar(result: sql.IResult<Record<string, unknown>>): unknown {
  const row = result.recordset?.[0];
  if (!row) return null;
  const values = Object.values(row);
  return values.length > 0 ? values[0] : null;
}

/**
 * Coerce a scalar the driver handed back into a number.
 *
 * The string branch is load-bearing, not defensive: **tedious returns SQL
 * `bigint` columns as strings** (`value.toString()` in its value parser), and
 * `idventa`, `idlinea` and `newcontador.NUMERO` are exactly the columns this
 * bridge does arithmetic on. PowerShell's `[long]` cast hid this in the
 * reference; `Number("123") + 1` would have produced "1231" here.
 */
export function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** A trimmed string, with NULL becoming "" the way `[string]$null` does. */
export function toText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

// ---------------------------------------------------------------------------
// Pure arithmetic
// ---------------------------------------------------------------------------

/**
 * Round half to EVEN — .NET's `[math]::Round` default, and therefore the
 * reference's. It differs from `Math.round` only at exact midpoints (2.5 → 2,
 * not 3), which is why it is here rather than in `lib/money.ts`: the portal
 * rounds half UP everywhere, and this function exists solely to reproduce the
 * ERP-facing arithmetic of the script Wingest already accepted.
 */
export function roundHalfToEven(value: number): number {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

/** `[math]::Round(x, 2)` on a euro amount. */
export function roundEuros(value: number): number {
  return roundHalfToEven(value * 100) / 100;
}

/**
 * CANPED/CANSER: the line in BASE units — cajas times the factor the order was
 * priced with.
 *
 * This REPLACES v3.2's `casesForLine` (`[int][math]::Round(qty/unilot)`), which
 * divided in the other direction because the reference was handed base units and
 * had to guess the case count. The portal knows the case count exactly — it is
 * what the customer typed — so the arithmetic runs forwards, and the division
 * (and its half-to-even rounding, and the 0 it produced for an article with no
 * UNILOT) is gone from the money path entirely.
 *
 * Multiplication only, and both operands are integers today. The weighed future
 * is the one case that is not: a fractional qty always comes with factor 1, and
 * `x * 1` is exact for every double, so this needs no special case for it.
 */
export function baseUnitsForLine(qty: number, unitsPerCase: number): number {
  return qty * unitsPerCase;
}

/**
 * SUBTOT/NETO in integer cents: cajas times the factor times the per-base-unit
 * price, in EXACT integer arithmetic.
 *
 * The portal computed the same product when it stored the line
 * (`round(p_qty * v_units * v_price)` in `create_order` and
 * `staff_update_order_line`), and `contractChecks` refuses to commit a pedido
 * where the two disagree. This is the whole reason the caja factor can be
 * trusted end to end: "equal" means equal, not equal-to-the-cent.
 *
 * **Why this is not `Math.round(qtyBase * unitPriceCents)`.** Postgres computes
 * that product in `numeric` — exact decimal — and rounds HALF AWAY FROM ZERO.
 * The obvious double version agrees for every whole-caja line, and disagreed
 * with it on exact half-cent ties as soon as weighed goods made a fractional
 * quantity reachable: 1.005 kg at 1.00 € is exactly 100.5 cents, which Postgres
 * stores as 101, while `1.005 * 100` in binary floating point is
 * 100.49999999999999 and rounds DOWN to 100. One cent apart, and fatal rather
 * than cosmetic — the SUBTOT contract check would refuse that order, and refuse
 * it identically on every lease retry, so the line would sit in the queue
 * forever instead of reaching Wingest.
 *
 * So the fraction never becomes a fraction. `qty` carries at most three decimals
 * (`numeric(10,3)`, and the portal validates the scale on both write paths), so
 * `qty x 1000` is an integer; scaling it up FIRST makes every later step exact
 * integer arithmetic, and the single division at the end lands on a value the
 * double format holds exactly whenever it matters. `n + 0.5` is exactly
 * representable, so `Math.round` breaks the tie upwards — which is Postgres's
 * half-away-from-zero for the positive amounts this function can ever see.
 *
 * **The magnitude is bounded well inside `Number.MAX_SAFE_INTEGER` (2^53).**
 * `qtyMilli` is at most 9,999,999 (the 9,999-caja cap the cart and
 * `validateLineQty` both enforce, at three decimals); `qty x unitsPerCase` is
 * capped at 1,000,000 by both write RPCs, so `qtyMilli x unitsPerCase` is at
 * most 1e9; and a line whose total does not fit `line_total_cents` (int4, so
 * under 2.15e9) could not have been stored in the first place. `totalMilli`
 * therefore stays under about 2.2e12, four orders of magnitude below the point
 * where an integer stops being exact. Anything that somehow got past all of
 * that would still not commit: the SUBTOT check compares this against the
 * portal's own exact number and rolls the order back.
 */
export function lineSubtotalCents(
  qty: number,
  unitsPerCase: number,
  unitPriceCents: number,
): number {
  const qtyMilli = Math.round(qty * 1000);
  const totalMilli = qtyMilli * unitsPerCase * unitPriceCents;
  return Math.round(totalMilli / 1000);
}

/** NUMLIN counts in fives, the way Wingest's own UI numbers lines. */
export function numlinFor(index: number): number {
  return 5 * (index + 1);
}

/** ULTLIN is the last NUMLIN written. */
export function ultlinFor(lineCount: number): number {
  return 5 * lineCount;
}

// ---------------------------------------------------------------------------
// Tax tables and totals
// ---------------------------------------------------------------------------

export type TaxSlot = 1 | 2 | 3 | 4 | 5;
export const TAX_SLOTS: readonly TaxSlot[] = [1, 2, 3, 4, 5];
/** v3.2: an article tax type with no POSMAT row falls into slot 3. */
export const DEFAULT_TAX_SLOT: TaxSlot = 3;

export interface TaxTables {
  /** `tipivaar.TIPIVAART` → `POSMAT`, the IMPBAS/TPCIVA/IMPIVA slot it owns. */
  slotByArticleType: ReadonlyMap<string, number>;
  /** The inverse: which article tax type each slot's TPCIVA rate belongs to. */
  articleTypeBySlot: ReadonlyMap<number, string>;
  /** `TIPIVACLI|TIPIVAART` → `iva.TPCIVA` (a percentage, e.g. 10). */
  rateByPair: ReadonlyMap<string, number>;
}

export function taxRateKey(tipivacli: string, tipivaart: string): string {
  return `${tipivacli}|${tipivaart}`;
}

export function buildTaxTables(
  tipivaarRows: readonly { T: unknown; POSMAT: unknown }[],
  ivaRows: readonly { C: unknown; A: unknown; TPCIVA: unknown }[],
): TaxTables {
  const slotByArticleType = new Map<string, number>();
  const articleTypeBySlot = new Map<number, string>();
  for (const row of tipivaarRows) {
    const type = toText(row.T);
    const slot = toNumber(row.POSMAT) ?? 0;
    slotByArticleType.set(type, slot);
    // v3.2 inverts the whole map, so when two article types share a slot the
    // last one seen owns the rate. The query is ORDER BY'd so "last" is stable
    // rather than whatever order the ERP happened to return today.
    articleTypeBySlot.set(slot, type);
  }
  const rateByPair = new Map<string, number>();
  for (const row of ivaRows) {
    rateByPair.set(taxRateKey(toText(row.C), toText(row.A)), toNumber(row.TPCIVA) ?? 0);
  }
  return { slotByArticleType, articleTypeBySlot, rateByPair };
}

export interface TaxedLine {
  lineTotalCents: number;
  tipivaart: string;
}

export interface TaxTotals {
  baseCents: Record<TaxSlot, number>;
  ratePct: Record<TaxSlot, number>;
  ivaCents: Record<TaxSlot, number>;
  netoCents: number;
  ivaTotalCents: number;
  totalCents: number;
}

function emptySlots(): Record<TaxSlot, number> {
  return { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
}

/**
 * The five IMPBAS/TPCIVA/IMPIVA slots, from the lines and the ERP's live tax
 * configuration.
 *
 * Bases are summed in integer CENTS — the portal's line totals are already
 * exact cents (delta 3), so there is nothing left to round and the float drift
 * the reference had to round away simply never happens. Only the IVA amounts
 * need rounding, and they use the reference's half-to-even rule.
 */
export function computeTaxes(
  lines: readonly TaxedLine[],
  tipivacli: string,
  tables: TaxTables,
): TaxTotals {
  const baseCents = emptySlots();
  for (const line of lines) {
    // `|| DEFAULT_TAX_SLOT` and not `??`: v3.2's `if(-not $s){$s=3}` also
    // catches POSMAT=0, which is how the ERP spells "unassigned".
    const slot = (tables.slotByArticleType.get(line.tipivaart) ?? 0) || DEFAULT_TAX_SLOT;
    if (!isTaxSlot(slot)) {
      // v3.2 would have written the base into a sixth hashtable key that no
      // header column reads: the line stays on the pedido while its base
      // silently vanishes from NETO. Refuse instead — a header whose totals do
      // not match its lines is exactly what the contract checks exist to stop.
      throw new Error(
        `tipivaar.POSMAT for TIPIVAART "${line.tipivaart}" is ${slot}; only 1..5 have header columns`,
      );
    }
    baseCents[slot] += line.lineTotalCents;
  }

  const ratePct = emptySlots();
  const ivaCents = emptySlots();
  let netoCents = 0;
  let ivaTotalCents = 0;
  for (const slot of TAX_SLOTS) {
    const articleType = tables.articleTypeBySlot.get(slot);
    // A missing iva row is 0%, matching `[double]$null` in the reference.
    ratePct[slot] =
      articleType === undefined
        ? 0
        : (tables.rateByPair.get(taxRateKey(tipivacli, articleType)) ?? 0);
    ivaCents[slot] = roundHalfToEven((baseCents[slot] * ratePct[slot]) / 100);
    netoCents += baseCents[slot];
    ivaTotalCents += ivaCents[slot];
  }

  return {
    baseCents,
    ratePct,
    ivaCents,
    netoCents,
    ivaTotalCents,
    totalCents: netoCents + ivaTotalCents,
  };
}

function isTaxSlot(value: number): value is TaxSlot {
  return value === 1 || value === 2 || value === 3 || value === 4 || value === 5;
}

// ---------------------------------------------------------------------------
// Customer defaults
// ---------------------------------------------------------------------------

export interface CustomerRow {
  TARCLI: unknown;
  TIPIVACLI: unknown;
  regiva: unknown;
  FORPAG: unknown;
  PRIPAG: unknown;
  NUMPAG: unknown;
  CALENV: unknown;
  CAL2: unknown;
  CODPOSENV: unknown;
  TIPPOR: unknown;
}

export interface CustomerDefaults {
  tarcli: number;
  tipivacli: string;
  regiva: string;
  forpag: string;
  pripag: number;
  numpag: number;
  calenv: string;
  cal2: string;
  cpenv: string;
  tippor: string;
}

/**
 * `clientes` row → the header's commercial fields, with v3.2's fallbacks for the
 * columns Wingest leaves blank on customers created through its own UI. These
 * are not our defaults to choose: they are the values the validated pedido
 * carried, and changing one changes how the ERP prices, ships and taxes.
 */
export function applyCustomerDefaults(row: CustomerRow): CustomerDefaults {
  const pripag = Math.trunc(toNumber(row.PRIPAG) ?? 0);
  const numpag = Math.trunc(toNumber(row.NUMPAG) ?? 0);
  return {
    tarcli: Math.trunc(toNumber(row.TARCLI) ?? 0),
    tipivacli: toText(row.TIPIVACLI),
    regiva: toText(row.regiva) || "R1",
    forpag: toText(row.FORPAG) || "CO",
    pripag: pripag > 0 ? pripag : 1,
    numpag: numpag > 0 ? numpag : 1,
    calenv: toText(row.CALENV),
    cal2: toText(row.CAL2),
    cpenv: toText(row.CODPOSENV),
    tippor: toText(row.TIPPOR) || "Portes Debidos",
  };
}

// ---------------------------------------------------------------------------
// Dates across the SQL boundary
// ---------------------------------------------------------------------------

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * A `date`/`datetime` the driver returned → `YYYY-MM-DD`.
 *
 * The UTC getters are the correct ones and not a bug waiting to happen:
 * `wingestPoolConfig` pins `useUTC: true`, so tedious builds the Date from the
 * server's calendar components via `Date.UTC`. Reading them back with local
 * getters would shift the date by this machine's offset.
 */
export function isoDateFromSql(value: unknown): string {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new Error("SQL Server returned an invalid date");
    }
    return `${value.getUTCFullYear()}-${pad2(value.getUTCMonth() + 1)}-${pad2(value.getUTCDate())}`;
  }
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)) {
    return value.slice(0, 10);
  }
  throw new Error(`SQL Server returned ${JSON.stringify(value)} where a date was expected`);
}

/** `YYYY-MM-DD` → the midnight Date `sql.Date` writes back unchanged. */
export function sqlDateFromIso(iso: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) throw new Error(`not a YYYY-MM-DD date: "${iso}"`);
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
}

/** v3.2's `[datetime]'1900-01-01'` — the FECCAD of a line with no lot. */
export const NO_EXPIRY_DATE = new Date(Date.UTC(1900, 0, 1));

// ---------------------------------------------------------------------------
// Header and line parameter builders
// ---------------------------------------------------------------------------

export interface HeaderInput {
  can: string;
  eje: number;
  numped: number;
  ref: string;
  codcli: number;
  fecent: Date;
  taxes: TaxTotals;
  totcosEuros: number;
  customer: CustomerDefaults;
  ultlin: number;
  serfac: number;
  idventa: number;
  erpUser: string;
}

export function buildHeaderParams(input: HeaderInput): ParamMap {
  const { taxes } = input;
  const params: ParamMap = {
    CAN: P.text(input.can),
    EJE: P.int(input.eje),
    NUMPED: P.int(input.numped),
    FECENT: P.date(input.fecent),
    EXT: P.text(input.ref),
    CODCLI: P.int(input.codcli),
    TOT: P.float(centsToEuros(taxes.totalCents)),
    NETO: P.float(centsToEuros(taxes.netoCents)),
    TOTCOS: P.float(input.totcosEuros),
    FORPAG: P.text(input.customer.forpag),
    PRIPAG: P.int(input.customer.pripag),
    NUMPAG: P.int(input.customer.numpag),
    TIPIVACLI: P.text(input.customer.tipivacli),
    CALENV: P.text(input.customer.calenv),
    CPENV: P.text(input.customer.cpenv),
    CAL2: P.text(input.customer.cal2),
    TIPPOR: P.text(input.customer.tippor),
    TARCLI: P.int(input.customer.tarcli),
    ULTLIN: P.int(input.ultlin),
    SERFAC: P.int(input.serfac),
    REGIVA: P.text(input.customer.regiva),
    IDVENTA: P.bigint(input.idventa),
    USU: P.text(input.erpUser),
  };
  for (const slot of TAX_SLOTS) {
    params[`B${slot}`] = P.float(centsToEuros(taxes.baseCents[slot]));
    params[`T${slot}`] = P.float(taxes.ratePct[slot]);
    params[`I${slot}`] = P.float(centsToEuros(taxes.ivaCents[slot]));
    // ESIMPBAS1..4 only: v3.2 stamps four of these against five IMPBAS slots.
    if (slot <= 4) params[`E${slot}`] = P.int(taxes.baseCents[slot] !== 0 ? 1 : 0);
  }
  return params;
}

/** One line, already resolved against `articulo` and `stolot`. */
export interface PreparedLine {
  codart: string;
  /**
   * CAJAS, as the customer ordered them. This is `pedclili.CAJ` on a
   * non-weighed line, and NOT the CAJ of a weighed one — see `buildLineParams`.
   */
  qty: number;
  /** Sold by weight: `qty` is kilos, and there are no cajas to count. */
  isWeighed: boolean;
  /** BASE units: `qty x units_per_case` — CANPED, CANSER, and the lot pick. */
  qtyBase: number;
  /** PREVEN in integer cents, per BASE unit. Kept for the SUBTOT invariant. */
  unitPriceCents: number;
  /** From the PORTAL payload (delta 3), not from `articulo`. */
  prevenEuros: number;
  lineTotalEuros: number;
  /** SUBTOT in cents: `qtyBase x unitPriceCents`, computed here. */
  lineTotalCents: number;
  /**
   * What the portal charged for this line. Equal to `lineTotalCents` on every
   * pedido that commits — `contractChecks` is where the two meet.
   */
  portalLineTotalCents: number;
  des: string;
  /** `articulo.PREMEDCOS` — cost is ERP truth. */
  precos: number;
  tipivaart: string;
  unilot: number;
  unidad: string;
  codlot: string;
  feccad: Date;
}

export interface LineInput {
  can: string;
  eje: number;
  numped: number;
  numlin: number;
  codcli: number;
  alm: string;
  fecent: Date;
  idlinea: number;
  line: PreparedLine;
}

export function buildLineParams(input: LineInput): ParamMap {
  const { line } = input;
  return {
    CAN: P.text(input.can),
    EJE: P.int(input.eje),
    NUMPED: P.int(input.numped),
    NUMLIN: P.int(input.numlin),
    COD: P.text(line.codart),
    // CANPED and CANSER both read @QTY: base units, what Wingest counts.
    QTY: P.float(line.qtyBase),
    PRE: P.float(line.prevenEuros),
    PRECOS: P.float(line.precos),
    DES: P.text(line.des),
    SUB: P.float(line.lineTotalEuros),
    ALM: P.text(input.alm),
    T: P.text(line.tipivaart),
    UNI: P.text(line.unidad),
    // UNILOT is the ERP's own packaging number, read from `articulo` (the
    // portal's `units_per_case` is a nightly copy of it).
    //
    // CAJ is the case count the customer ordered, taken straight from the
    // quantity and never divided back out of it — EXCEPT on a weighed line,
    // where there is no case count to take. There `qty` is kilos, and CAJ is 0:
    // the kilos ride on CANPED/CANSER (@QTY) and Wingest's own UI leaves Cajas
    // at 0 on a KILO line, so this is the shape its pedido→albarán conversion
    // already expects. `P.int` is an `[int]` parameter and would otherwise
    // TRUNCATE the kilos into a case count — 5.2 kg silently becoming 5 cajas,
    // and 0.5 kg becoming 0 — which is a lie in a column staff read.
    UNILOT: P.float(line.unilot),
    CAJ: P.int(line.isWeighed ? 0 : line.qty),
    LOT: P.text(line.codlot),
    FCAD: P.datetime(line.feccad),
    FECENT: P.date(input.fecent),
    CODCLI: P.int(input.codcli),
    IDL: P.bigint(input.idlinea),
  };
}

// ---------------------------------------------------------------------------
// Steps — each takes a pool or a transaction, so they diff against v3.2 one
// statement at a time.
// ---------------------------------------------------------------------------

/**
 * v3.2 aborted unless `DB_NAME()` was literally `wg_test`. Generalised to the
 * configured database: the point is that the connection really is where
 * `bridge.env` says, before anything writes a row. Case-insensitive, because
 * SQL Server database names are compared under the server collation.
 */
export async function assertDatabase(parent: SqlParent, cfg: BridgeConfig): Promise<void> {
  const result = await runQuery<Record<string, unknown>>(parent, "SELECT DB_NAME()");
  const actual = toText(firstScalar(result));
  if (actual.toLowerCase() !== cfg.wingestDb.toLowerCase()) {
    throw new Error(
      `connected to database "${actual}" but WINGEST_DB is "${cfg.wingestDb}"`,
    );
  }
}

/** Today in Madrid, decided by SQL Server — never by this process's clock. */
export async function readMadridToday(parent: SqlParent): Promise<string> {
  const result = await runQuery<Record<string, unknown>>(
    parent,
    `SELECT ${MADRID_TODAY_SQL}`,
  );
  return isoDateFromSql(firstScalar(result));
}

/**
 * Delta 2: has this portal order already been injected? Both the live header
 * table and its history are checked, and a hit RECOVERS rather than fails —
 * that is what closes the crash-after-inject-before-mark window, where the
 * order was re-claimed after its NUMPED was already written.
 *
 * Filtered on CAN only, as v3.2 was: `PORTAL-<order_number>` is unique for all
 * time, so a hit under a previous EJE is still the same pedido. Newest EJE wins.
 */
export async function dedupCheck(
  parent: SqlParent,
  cfg: BridgeConfig,
  ref: string,
): Promise<number | null> {
  const result = await runQuery<Record<string, unknown>>(
    parent,
    "SELECT TOP 1 z.NUMPED FROM (" +
      "SELECT EJE, NUMPED FROM pedclica WHERE CAN=@can AND RTRIM(NUMPEDCLI)=@ext" +
      " UNION ALL " +
      "SELECT EJE, NUMPED FROM pedclicah WHERE CAN=@can AND RTRIM(NUMPEDCLI)=@ext" +
      ") z ORDER BY z.EJE DESC, z.NUMPED DESC",
    { can: P.text(cfg.can), ext: P.text(ref) },
  );
  const numped = toNumber(firstScalar(result));
  return numped !== null && numped > 0 ? numped : null;
}

export async function loadCustomer(
  parent: SqlParent,
  codcli: number,
): Promise<CustomerDefaults> {
  const result = await runQuery<CustomerRow>(
    parent,
    "SELECT TARCLI, RTRIM(TIPIVACLI) AS TIPIVACLI, RTRIM(regiva) AS regiva," +
      " RTRIM(FORPAG) AS FORPAG, PRIPAG, NUMPAG, RTRIM(CALENV) AS CALENV," +
      " RTRIM(CAL2) AS CAL2, RTRIM(CODPOSENV) AS CODPOSENV, RTRIM(TIPPOR) AS TIPPOR" +
      " FROM clientes WHERE CODCLI=@codcli",
    { codcli: P.int(codcli) },
  );
  const row = result.recordset?.[0];
  if (!row) throw new Error(`clientes has no CODCLI ${codcli}`);
  return applyCustomerDefaults(row);
}

export async function loadTaxTables(
  parent: SqlParent,
  cfg: BridgeConfig,
): Promise<TaxTables> {
  const slots = await runQuery<{ T: unknown; POSMAT: unknown }>(
    parent,
    "SELECT RTRIM(TIPIVAART) AS T, POSMAT FROM tipivaar ORDER BY RTRIM(TIPIVAART)",
  );
  // A generalisation the plan does not list: v3.2 hard-codes `WHERE CAN='B'`,
  // and this reads `@can` from bridge.env. CAN is a deployment choice — which
  // sales company the portal feeds — so it belongs in configuration, the same
  // way EJE and ALM do. The `ELEMENTO='IDVENTA'`-style literals elsewhere are
  // the opposite: they name rows of Wingest's own schema, are as fixed as the
  // column names beside them, and would be meaningless as settings.
  const rates = await runQuery<{ C: unknown; A: unknown; TPCIVA: unknown }>(
    parent,
    "SELECT RTRIM(TIPIVACLI) AS C, RTRIM(TIPIVAART) AS A, TPCIVA FROM iva WHERE CAN=@can",
    { can: P.text(cfg.can) },
  );
  return buildTaxTables(slots.recordset ?? [], rates.recordset ?? []);
}

interface ArticleRow {
  DES: unknown;
  PRECOS: unknown;
  T: unknown;
  UNILOT: unknown;
  UNI: unknown;
}

/**
 * The ERP half of a line: description, cost, tax type, packaging.
 *
 * v3.2 also read the customer's tier price column here (`PREVENA`..`PREVENF`,
 * chosen by string interpolation); delta 3 drops that read entirely — the price
 * comes from the portal payload — which is also what removes the last dynamic
 * identifier from the SQL in this file.
 */
export async function loadArticle(
  parent: SqlParent,
  codart: string,
): Promise<{ des: string; precos: number; tipivaart: string; unilot: number; unidad: string }> {
  const result = await runQuery<ArticleRow>(
    parent,
    "SELECT RTRIM(DES) AS DES, PREMEDCOS AS PRECOS, RTRIM(TIPIVAART) AS T," +
      " UNILOT, RTRIM(UNIDAD) AS UNI FROM articulo WHERE CODART=@codart",
    { codart: P.text(codart) },
  );
  const row = result.recordset?.[0];
  // v3.2 silently DROPPED a line whose article it could not find. That is safe
  // for a hand-run sandbox script and unsafe here: the customer confirmed and
  // was charged for this line, and a pedido quietly short one line would ship
  // short. Only `is_erp_excluded` (delta 4) removes a line from a pedido.
  if (!row) throw new Error(`articulo has no CODART "${codart}"`);
  return {
    des: toText(row.DES),
    precos: toNumber(row.PRECOS) ?? 0,
    tipivaart: toText(row.T),
    unilot: toNumber(row.UNILOT) ?? 0,
    unidad: toText(row.UNI),
  };
}

/**
 * What Wingest will actually let a pedido take out of a lot.
 *
 * `stolot.CANT` is the lot's PHYSICAL quantity, and picking on it is what v3.2
 * did. The sandbox E2E of **2026-08-16** proved that is NOT what Wingest's
 * pedido→albarán conversion checks: it subtracts what every still-OPEN pedido
 * has outstanding on the same lot (`CANPED-CANSER`) and refuses the conversion
 * when the remainder is short, behind a modal dialog only a human can clear.
 *
 * The evidence, from that run: lot 4851351437 in almacén 00001 held `CANT=+24`;
 * an old open pedido (`NUMPED` 11, `ESTPED='Abierto'`) held `CANPED=48`,
 * `CANSER=0` on it; Wingest reported "Disponible: -24" (24−48) and would not
 * convert. After `CANT` was topped up to 124 the same conversion passed
 * (124−48=76). So the injector picks on THIS number, not on `CANT`, and the
 * pedidos it writes convert without anyone standing at the screen.
 *
 * Two properties of the expression are deliberate:
 *
 *   - **The reservation is not scoped to an ejercicio.** An open pedido from an
 *     earlier EJE still holds its stock and Wingest still counts it, so nothing
 *     here compares EJE to `cfg.eje`. The `c.EJE=l.EJE` inside the join is the
 *     line↔header correlation (`pedclili`'s key is CAN/EJE/NUMPED/NUMLIN), not
 *     a filter.
 *   - **A pedido this bridge wrote never counts against itself.** It writes
 *     `CANSER=CANPED` (see `PEDCLILI_COLUMNS`), so its outstanding quantity is
 *     zero — which is the same arithmetic Wingest does, not a special case.
 *
 * The correlation predicates are NOT wrapped in `RTRIM`: trailing blanks are
 * insignificant in char equality (SQL Server blank-pads the shorter side), so
 * un-RTRIM'd columns mean the same thing and leave the `pedclili`/`pedclica`
 * lookups seekable — an index scan per line is not something to spend on a
 * shared ERP box. It is the same reliance `l.CODALM=s.CODALM` already had. The
 * outer query's `RTRIM(s.CODART)=@codart` compares against a PARAMETER, not a
 * column, and stays as v3.2 wrote it.
 *
 * They ARE wrapped in `COLLATE DATABASE_DEFAULT`, on the `s` side. Wingest's
 * tables carry mixed collations, and the sandbox run of **2026-08-16** (order
 * 1006, `PREFLIGHT_FAILED`) hit it: `Cannot resolve the collation conflict
 * between "Modern_Spanish_CS_AS" and "Modern_Spanish_CI_AS" in the equal to
 * operation.` Each of these three predicates compares a `pedclili` column to a
 * `stolot` one, and when the two columns' collations differ SQL Server has two
 * IMPLICIT labels and no rule to pick between them, so the statement fails to
 * compile — in the read phase, before any write, which is why that order lost
 * nothing but its lease. An EXPLICIT collation label beats an implicit one, so
 * labelling either side makes the comparison resolve no matter which table
 * turns out to be the odd one out. It goes on `s` because that is the outer
 * row — one value per evaluation, not a column the subquery has to seek on —
 * which keeps the `pedclili`/`pedclica` lookups seekable whenever `pedclili`
 * already matches the database default; if it does not, the cost is a seek,
 * not a wrong answer. `c.ESTPED='Abierto'` compares against a literal, which
 * takes the column's collation, and needs nothing.
 *
 * `ISNULL` appears twice over: once per quantity, so a Wingest-written row with
 * a NULL `CANPED` or `CANSER` contributes what it holds instead of turning the
 * whole `SUM` NULL, and once around the subquery, so a lot nobody has booked
 * counts as zero reserved rather than as no availability at all.
 *
 * `s` is the `stolot` row this is correlated to; the expression is parenthesised
 * so it can be compared and ordered by as one value.
 */
export const LOT_AVAILABLE_SQL =
  "(s.CANT - ISNULL((SELECT SUM(ISNULL(l.CANPED,0) - ISNULL(l.CANSER,0)) FROM pedclili l" +
  " JOIN pedclica c ON c.CAN=l.CAN AND c.EJE=l.EJE AND c.NUMPED=l.NUMPED" +
  " WHERE c.ESTPED='Abierto' AND l.CODALM=s.CODALM COLLATE DATABASE_DEFAULT" +
  " AND l.CODART=s.CODART COLLATE DATABASE_DEFAULT" +
  " AND l.CODLOT=s.CODLOT COLLATE DATABASE_DEFAULT), 0))";

/**
 * The half both lot queries share: this almacén, this article, sellable, not
 * expired.
 *
 * `FECCAD>GETDATE()` stays on the server clock deliberately: it asks "has this
 * lot expired *now*", which is a moment and not a business day, and the hours of
 * difference between the server's zone and Madrid can only matter for a lot
 * expiring within those same hours. `FECCAD<'19010101'` is the ERP's way of
 * spelling "no expiry".
 */
const LOT_SELECT_SQL =
  "SELECT TOP 1 RTRIM(s.CODLOT) AS LOT, s.FECCAD FROM stolot s" +
  " WHERE s.CODALM=@alm AND RTRIM(s.CODART)=@codart" +
  " AND (s.FECCAD>GETDATE() OR s.FECCAD<'19010101') AND s.VENDIBLE=1 AND ";

/** FIFO: the soonest-expiring lot with enough left to cover the line by itself. */
export const LOT_COVERING_SQL = `${LOT_SELECT_SQL}${LOT_AVAILABLE_SQL}>=@qty ORDER BY s.FECCAD ASC`;

/**
 * Nothing covers the line alone: the lot with the most REAL availability left.
 *
 * Ordering by `CANT` here would hand back the lot with the most stock on the
 * shelf even when all of it is already promised — precisely the pick that stops
 * a conversion.
 */
export const LOT_FALLBACK_SQL =
  `${LOT_SELECT_SQL}${LOT_AVAILABLE_SQL}>0 ORDER BY ${LOT_AVAILABLE_SQL} DESC`;

/**
 * Lot pick: the soonest-expiring sellable lot whose REAL availability covers the
 * line on its own, else the sellable lot with the most availability left, else
 * no lot at all (empty CODLOT, 1900-01-01, exactly as v3.2 did).
 *
 * "Availability" is `LOT_AVAILABLE_SQL` — `CANT` minus what open pedidos still
 * hold — and not `CANT`; see that constant for the 2026-08-16 evidence and for
 * why this is a deliberate departure from the v3.2 reference.
 */
export async function pickLot(
  parent: SqlParent,
  cfg: BridgeConfig,
  codart: string,
  qty: number,
): Promise<{ codlot: string; feccad: Date }> {
  const params = {
    alm: P.text(cfg.alm),
    codart: P.text(codart),
    qty: P.float(qty),
  };
  const covering = await runQuery<{ LOT: unknown; FECCAD: unknown }>(
    parent,
    LOT_COVERING_SQL,
    params,
  );
  let row = covering.recordset?.[0];
  if (!row) {
    const fallback = await runQuery<{ LOT: unknown; FECCAD: unknown }>(
      parent,
      LOT_FALLBACK_SQL,
      params,
    );
    row = fallback.recordset?.[0];
  }
  if (!row) return { codlot: "", feccad: NO_EXPIRY_DATE };
  const feccad = row.FECCAD;
  return {
    codlot: toText(row.LOT),
    feccad: feccad instanceof Date && !Number.isNaN(feccad.getTime()) ? feccad : NO_EXPIRY_DATE,
  };
}

export interface ReservedCounters {
  numped: number;
  idventa: number;
  /** The first `pedclili.idlinea`; the run owns `lineBase .. lineBase+N-1`. */
  lineBase: number;
}

/**
 * Reserve the three document numbers, v3.2's way.
 *
 * NUMPED comes from the per-CAN/EJE counter with an atomic
 * `UPDATE ... OUTPUT deleted.NUMERO`, which hands this transaction the old value
 * and increments in one statement.
 *
 * The two global ZZ/99 counters (`IDVENTA`, `IDPEDCLILI`) are instead taken as
 * `GREATEST(counter, MAX(existing)+1)`. That anti-collision read exists because
 * those counters drift behind the data in practice — Wingest itself does not
 * always advance them — and a duplicate `idventa` makes a pedido the conversion
 * engine will not touch.
 */
export async function reserveCounters(
  parent: SqlParent,
  cfg: BridgeConfig,
  lineCount: number,
): Promise<ReservedCounters> {
  const scope = { can: P.text(cfg.can), eje: P.int(cfg.eje) };
  const numpedResult = await runQuery<Record<string, unknown>>(
    parent,
    "UPDATE newcontador SET NUMERO=NUMERO+1 OUTPUT deleted.NUMERO" +
      " WHERE CAN=@can AND EJE=@eje AND ELEMENTO='NUMPEDCLI'",
    scope,
  );
  const numped = toNumber(firstScalar(numpedResult));
  // v3.2's `[int]$null` would have made this 0 and written a pedido numbered
  // zero. A missing counter row means the CAN/EJE in bridge.env does not exist
  // in this database, which is a configuration error, not a document number.
  if (numped === null || !Number.isSafeInteger(numped) || numped <= 0) {
    throw new Error(
      `newcontador has no usable NUMPEDCLI counter for CAN=${cfg.can} EJE=${cfg.eje}`,
    );
  }

  const idventa = await reserveGlobalCounter(parent, "IDVENTA", 1);
  const lineBase = await reserveGlobalCounter(parent, "IDPEDCLILI", lineCount);

  return { numped, idventa, lineBase };
}

/**
 * The two global ZZ/99 counters and the "what actually exists" query each is
 * checked against. Both statement sets are picked by literal key — nothing here
 * is ever assembled from data.
 */
const GLOBAL_COUNTERS = {
  IDVENTA: {
    read: "SELECT NUMERO FROM newcontador WHERE CAN='ZZ' AND EJE=99 AND ELEMENTO='IDVENTA'",
    write:
      "UPDATE newcontador SET NUMERO=@next WHERE CAN='ZZ' AND EJE=99 AND ELEMENTO='IDVENTA'",
    max:
      "SELECT ISNULL(MAX(idventa),0) FROM (SELECT idventa FROM pedclica" +
      " UNION ALL SELECT idventa FROM albfacca) z",
  },
  IDPEDCLILI: {
    read: "SELECT NUMERO FROM newcontador WHERE CAN='ZZ' AND EJE=99 AND ELEMENTO='IDPEDCLILI'",
    write:
      "UPDATE newcontador SET NUMERO=@next WHERE CAN='ZZ' AND EJE=99 AND ELEMENTO='IDPEDCLILI'",
    max:
      "SELECT ISNULL(MAX(idlinea),0) FROM (SELECT idlinea FROM pedclili" +
      " UNION ALL SELECT idlinea FROM albfacli) z",
  },
} as const;

/**
 * One ZZ/99 counter: read it, read the real maximum, take the larger, and write
 * back the next free value after reserving `reserve` ids.
 */
async function reserveGlobalCounter(
  parent: SqlParent,
  element: keyof typeof GLOBAL_COUNTERS,
  reserve: number,
): Promise<number> {
  const { read: counterSql, write: updateSql, max: maxSql } = GLOBAL_COUNTERS[element];
  const counter = toNumber(firstScalar(await runQuery(parent, counterSql))) ?? 0;
  const highest = toNumber(firstScalar(await runQuery(parent, maxSql))) ?? 0;
  const base = Math.max(counter, highest + 1);
  if (!Number.isSafeInteger(base) || base <= 0) {
    throw new Error(`${element} resolved to ${base}, which is not a usable id`);
  }
  await runQuery(parent, updateSql, { next: P.bigint(base + reserve) });
  return base;
}

export async function insertHeader(parent: SqlParent, input: HeaderInput): Promise<void> {
  await runQuery(parent, PEDCLICA_INSERT_SQL, buildHeaderParams(input));
}

/**
 * `pedclica_adi`: the picking row Wingest's warehouse module expects. v3.2's
 * literals — `estprepara=0` (not yet prepared), `priprepara='9999'` (lowest
 * priority) — are schema constants, so they stay in the statement.
 */
export async function insertAdi(
  parent: SqlParent,
  cfg: BridgeConfig,
  numped: number,
): Promise<void> {
  await runQuery(
    parent,
    "INSERT INTO pedclica_adi (can,eje,numped,estprepara,priprepara)" +
      " VALUES (@CAN,@EJE,@NUMPED,0,'9999')",
    { CAN: P.text(cfg.can), EJE: P.int(cfg.eje), NUMPED: P.int(numped) },
  );
}

export async function insertLines(
  parent: SqlParent,
  cfg: BridgeConfig,
  context: { numped: number; codcli: number; fecent: Date; lineBase: number },
  lines: readonly PreparedLine[],
): Promise<void> {
  for (const [index, line] of lines.entries()) {
    await runQuery(
      parent,
      PEDCLILI_INSERT_SQL,
      buildLineParams({
        can: cfg.can,
        eje: cfg.eje,
        numped: context.numped,
        numlin: numlinFor(index),
        codcli: context.codcli,
        alm: cfg.alm,
        fecent: context.fecent,
        idlinea: context.lineBase + index,
        line,
      }),
    );
  }
}

/**
 * The pre-commit self-checks. Four are v3.2's, kept verbatim (delta 6): each one
 * asserts a property Wingest's pedido→albarán conversion silently depends on,
 * and any failure rolls the whole order back rather than leaving a document the
 * ERP will choke on later.
 *
 * - subtotales: `SUBTOT = qtyBase x PREVEN` really is what the portal charged
 *   (2026-08-16, the caja decision — the one check v3.2 has no counterpart for)
 * - cabecera: exactly one header, open, un-albaranado, with FECPED and FECENT at
 *   midnight (a time component makes Wingest treat the dates as invalid)
 * - lineas: every line servible, `CANSER=CANPED>0`, FECENT at midnight
 * - usuario: `CODUSU` really exists in `susuario`
 * - adi: exactly one `pedclica_adi` row
 */
export async function contractChecks(
  parent: SqlParent,
  cfg: BridgeConfig,
  numped: number,
  codcli: number,
  lines: readonly PreparedLine[],
): Promise<void> {
  const scope = {
    can: P.text(cfg.can),
    eje: P.int(cfg.eje),
    numped: P.int(numped),
  };
  const lineCount = lines.length;

  // The one check that costs no round trip, and the only one that is about MONEY
  // rather than about what the conversion engine will accept. Two integers in
  // cents: base units times the per-base-unit price on one side, the amount the
  // customer confirmed on the portal on the other. They are the same arithmetic
  // — `create_order` stores `qty x units_per_case x unit_price_cents` — so any
  // difference means the two systems disagree about what a caja holds, and the
  // pedido that would ship is the one for the wrong number of bottles. The most
  // likely way to get here is a claim from before the RPC carried
  // `units_per_case`, whose factor `lineParams` defaulted to 1.
  for (const line of lines) {
    if (line.lineTotalCents !== line.portalLineTotalCents) {
      throw new Error(
        `CONTRATO: SUBTOT de ${line.codart} — ${line.qtyBase} x ` +
          `${line.unitPriceCents} = ${line.lineTotalCents} céntimos, ` +
          `el portal cobró ${line.portalLineTotalCents}`,
      );
    }
  }

  const header = toNumber(
    firstScalar(
      await runQuery(
        parent,
        "SELECT COUNT(*) FROM pedclica WHERE CAN=@can AND EJE=@eje AND NUMPED=@numped" +
          " AND CODCLI=@codcli AND SERFAC=@serfac AND IDTALLER=0" +
          " AND RTRIM(ESTPED)='Abierto' AND ALBARAN=0 AND ACTALB=0" +
          " AND CONVERT(time,FECPED)='00:00:00' AND CONVERT(time,FECENT)='00:00:00'",
        { ...scope, codcli: P.int(codcli), serfac: P.int(cfg.serfac) },
      ),
    ),
  );
  if (header !== 1) {
    throw new Error(
      `CONTRATO: cabecera no cumple (fecha medianoche/estado) — matched ${header}`,
    );
  }

  const servible = toNumber(
    firstScalar(
      await runQuery(
        parent,
        "SELECT COUNT(*) FROM pedclili WHERE CAN=@can AND EJE=@eje AND NUMPED=@numped" +
          " AND CANSER>0 AND CANSER=CANPED AND CONVERT(time,FECENT)='00:00:00'",
        scope,
      ),
    ),
  );
  if (servible !== lineCount) {
    throw new Error(`CONTRATO: lineas servibles ${servible} de ${lineCount}`);
  }

  const user = toNumber(
    firstScalar(
      await runQuery(parent, "SELECT COUNT(*) FROM susuario WHERE RTRIM(CODUSU)=@usu", {
        usu: P.text(cfg.erpUser),
      }),
    ),
  );
  if (user !== 1) {
    throw new Error(`CONTRATO: usuario ${cfg.erpUser} no existe`);
  }

  const adi = toNumber(
    firstScalar(
      await runQuery(
        parent,
        "SELECT COUNT(*) FROM pedclica_adi WHERE RTRIM(can)=@can AND eje=@eje AND numped=@numped",
        scope,
      ),
    ),
  );
  if (adi !== 1) {
    throw new Error("CONTRATO: pedclica_adi <> 1 fila");
  }
}

// ---------------------------------------------------------------------------
// injectOrder
// ---------------------------------------------------------------------------

export interface InjectResult {
  numped: number;
  /** True when the pedido already existed and we recovered its NUMPED. */
  recovered: boolean;
  /**
   * Lines THIS run wrote — so it is 0 on the recovery path, where the pedido
   * was already there and nothing was inserted. A summary that adds this up
   * counts lines injected, not lines on the pedido; the two differ by exactly
   * the recovered orders.
   */
  lineCount: number;
  /** codarts left off the pedido because `is_erp_excluded` (delta 4). */
  excludedCodarts: string[];
}

/** Everything the write phase needs, resolved and arithmetic already done. */
export interface PreparedOrder {
  ref: string;
  codcli: number;
  fecent: Date;
  customer: CustomerDefaults;
  taxes: TaxTotals;
  totcosEuros: number;
  lines: PreparedLine[];
  excludedCodarts: string[];
}

export function orderContext(order: ClaimedOrder, ref: string): {
  orderId: string;
  orderNumber: number;
  ref: string;
} {
  return { orderId: order.id, orderNumber: order.order_number, ref };
}

/**
 * READ phase: everything the pedido needs from the ERP, plus the arithmetic.
 *
 * Runs OUTSIDE the transaction, exactly where v3.2 ran it. Keeping `clientes`,
 * `articulo`, `stolot`, `tipivaar`, `iva` — and, since the lot pick started
 * subtracting open reservations, `pedclica` and `pedclili` — out of a
 * SERIALIZABLE transaction keeps their range locks out of it too. The two
 * pedido tables are therefore READ here and WRITTEN later under the
 * transaction; what this bridge races itself on is those writes and the
 * counters, and a lot pick made a moment before them is a snapshot either way:
 * Wingest re-checks availability at conversion, which is the check that counts.
 */
export async function prepareOrder(
  parent: SqlParent,
  cfg: BridgeConfig,
  order: ClaimedOrder,
): Promise<PreparedOrder> {
  const ref = portalRef(order.order_number);
  const { included, excluded } = splitLines(order.items);
  const excludedCodarts = excluded.map((item) => item.codart);
  if (included.length === 0) {
    throw new AllLinesExcludedError(orderContext(order, ref));
  }
  const payloadLines = included.map(lineParams);

  const madridToday = await readMadridToday(parent);
  const fecent = sqlDateFromIso(resolveFecent(order.delivery_date, madridToday));
  const customer = await loadCustomer(parent, order.codcli);
  const taxTables = await loadTaxTables(parent, cfg);

  const lines: PreparedLine[] = [];
  for (const line of payloadLines) {
    const article = await loadArticle(parent, line.codart);
    // Base units, and everything downstream counts them: the lot pick asks
    // `stolot` for BOTTLES, not for cases — two cajas of 24 need 48 available,
    // and asking for 2 would happily pick a lot with 3 bottles left on it.
    const qtyBase = baseUnitsForLine(line.qty, line.unitsPerCase);
    const lot = await pickLot(parent, cfg, line.codart, qtyBase);
    // The three operands, not the product: `qtyBase` is already a double and the
    // cent has to be decided on exact integers. See `lineSubtotalCents`.
    const lineTotalCents = lineSubtotalCents(
      line.qty,
      line.unitsPerCase,
      line.unitPriceCents,
    );
    lines.push({
      codart: line.codart,
      qty: line.qty,
      isWeighed: line.isWeighed,
      qtyBase,
      unitPriceCents: line.unitPriceCents,
      prevenEuros: line.unitPriceEuros,
      lineTotalEuros: centsToEuros(lineTotalCents),
      lineTotalCents,
      portalLineTotalCents: line.lineTotalCents,
      des: article.des,
      precos: article.precos,
      tipivaart: article.tipivaart,
      unilot: article.unilot,
      unidad: article.unidad,
      codlot: lot.codlot,
      feccad: lot.feccad,
    });
  }

  return {
    ref,
    codcli: order.codcli,
    fecent,
    customer,
    taxes: computeTaxes(lines, customer.tipivacli, taxTables),
    // TOTCOS stays in float euros because its input does: PREMEDCOS is a
    // moving-average cost the ERP keeps to more than two decimals. It counts
    // `qtyBase` because PREMEDCOS is a cost per BASE unit, like every other
    // quantity-times-price on this pedido.
    totcosEuros: roundEuros(lines.reduce((sum, line) => sum + line.qtyBase * line.precos, 0)),
    lines,
    excludedCodarts,
  };
}

/**
 * WRITE phase, in the caller's transaction: dedup, counters, header, adi, lines,
 * contract checks. Returns `recovered` when the dedup key was already there and
 * nothing was written.
 */
export async function runInjectSteps(
  parent: SqlParent,
  cfg: BridgeConfig,
  prepared: PreparedOrder,
): Promise<{ numped: number; recovered: boolean }> {
  const existing = await dedupCheck(parent, cfg, prepared.ref);
  if (existing !== null) return { numped: existing, recovered: true };

  const counters = await reserveCounters(parent, cfg, prepared.lines.length);
  await insertHeader(parent, {
    can: cfg.can,
    eje: cfg.eje,
    numped: counters.numped,
    ref: prepared.ref,
    codcli: prepared.codcli,
    fecent: prepared.fecent,
    taxes: prepared.taxes,
    totcosEuros: prepared.totcosEuros,
    customer: prepared.customer,
    ultlin: ultlinFor(prepared.lines.length),
    serfac: cfg.serfac,
    idventa: counters.idventa,
    erpUser: cfg.erpUser,
  });
  await insertAdi(parent, cfg, counters.numped);
  await insertLines(
    parent,
    cfg,
    {
      numped: counters.numped,
      codcli: prepared.codcli,
      fecent: prepared.fecent,
      lineBase: counters.lineBase,
    },
    prepared.lines,
  );
  await contractChecks(parent, cfg, counters.numped, prepared.codcli, prepared.lines);
  return { numped: counters.numped, recovered: false };
}

/**
 * One claimed order → one pedido, or a clean rollback and a thrown
 * `InjectError` naming the order.
 */
export async function injectOrder(
  pool: sql.ConnectionPool,
  cfg: BridgeConfig,
  order: ClaimedOrder,
): Promise<InjectResult> {
  const ref = portalRef(order.order_number);
  const context = orderContext(order, ref);
  const fail = (code: string, error: unknown): InjectError =>
    error instanceof InjectError
      ? error
      : new InjectError(
          code,
          error instanceof Error ? error.message : String(error),
          context,
          { cause: error },
        );

  let prepared: PreparedOrder;
  try {
    await assertDatabase(pool, cfg);
    prepared = await prepareOrder(pool, cfg, order);
  } catch (error) {
    throw fail("PREFLIGHT_FAILED", error);
  }

  const transaction = new sql.Transaction(pool);
  try {
    await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
  } catch (error) {
    throw fail("BEGIN_FAILED", error);
  }

  let committed = false;
  try {
    const result = await runInjectSteps(transaction, cfg, prepared);
    // The recovery path wrote nothing, so this commit only releases the read
    // locks — and the NUMPED still goes back as a SUCCESS, because the pedido
    // does exist and recording it against the order is exactly what was missed.
    await transaction.commit();
    committed = true;
    return {
      numped: result.numped,
      recovered: result.recovered,
      lineCount: result.recovered ? 0 : prepared.lines.length,
      excludedCodarts: prepared.excludedCodarts,
    };
  } catch (error) {
    if (!committed) {
      // v3.2's `try{$tx.Rollback()}catch{}`: SQL Server may already have killed
      // the transaction, and a rollback that fails must not replace the real
      // cause with a message about rolling back.
      try {
        await transaction.rollback();
      } catch {
        /* already rolled back, or the connection is gone */
      }
    }
    throw fail("INJECT_FAILED", error);
  }
}

/** The pool the jobs hand to `injectOrder`. Kept here so Task 2 has one door. */
export async function connectWingest(cfg: BridgeConfig): Promise<sql.ConnectionPool> {
  const pool = new sql.ConnectionPool(wingestPoolConfig(cfg));
  return pool.connect();
}
