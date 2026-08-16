import { centsFromEuros } from "@/lib/money";

/**
 * The exact header written by scripts/wingest/export-prices.ps1, which the owner
 * runs on the ERP server. Checking it byte for byte is the only guard we have
 * that the file in front of us really is that export: the columns are otherwise
 * indistinguishable positional numbers, and merging them in the wrong order
 * would write tier 6 prices into tier 1.
 */
export const WINGEST_PRICE_CSV_HEADER = "codart,p1,p2,p3,p4,p5,p6,unidad,unilot";

const CSV_FIELD_COUNT = 9;

/**
 * U+FEFF, built from its code point rather than written as a literal: an
 * invisible character in source is one no reviewer can see and some editors
 * silently strip.
 */
const BOM = String.fromCharCode(0xfeff);

/**
 * One raw CSV line, still in ERP units (euro text, ERP unit names). Every field
 * is deliberately a STRING, the shape the CSV hands us: an empty cell and a NULL
 * column both arrive as "". Plan 04's direct-SQL price sync can reuse this same
 * transform by stringifying its column values with `String(value ?? "")` instead
 * of inventing a second set of merge rules.
 */
export interface WingestPriceRow {
  codart: string;
  p1: string;
  p2: string;
  p3: string;
  p4: string;
  p5: string;
  p6: string;
  unidad: string;
  unilot: string;
}

/**
 * A products UPDATE payload. `unit` and `is_weighed` are OPTIONAL on purpose —
 * an absent key leaves the stored value alone, which is not the same as writing
 * a default over it (see toWingestPricePatch).
 *
 * `units_per_case` is NOT nullable, unlike the six price tiers: a missing price
 * means "do not sell this", which NULL says exactly, while a missing factor
 * means "one caja is one unit", which is the number 1 (see `unitsPerCase`).
 */
export interface WingestPricePatch {
  price_1_cents: number | null;
  price_2_cents: number | null;
  price_3_cents: number | null;
  price_4_cents: number | null;
  price_5_cents: number | null;
  price_6_cents: number | null;
  units_per_case: number;
  erp_synced_at: string;
  unit?: string;
  is_weighed?: true;
}

/**
 * Split the export into rows. The export writes plain positional values with no
 * quoting — every field passes through PowerShell's `.Replace(',', '.')`, so a
 * comma cannot survive inside a field — which is why a naive split is safe here
 * and a field-count mismatch means the file is not the export we expect.
 */
export function parseWingestPriceCsv(text: string): WingestPriceRow[] {
  // A spreadsheet round-trip prepends a BOM; without this the header comparison
  // fails on an invisible character and the operator sees an identical-looking
  // "got" string in the error.
  const body = text.startsWith(BOM) ? text.slice(BOM.length) : text;
  const lines = body.split(/\r?\n/);
  const header = lines.shift()?.trim() ?? "";
  if (header !== WINGEST_PRICE_CSV_HEADER) {
    throw new Error(
      `Wingest CSV header must be "${WINGEST_PRICE_CSV_HEADER}"; got "${header}"`,
    );
  }

  const rows: WingestPriceRow[] = [];
  lines.forEach((line, index) => {
    if (!line.trim()) return;
    // Header consumed above, and line numbers are 1-based: the first data line
    // is line 2 of the file, which is what an operator sees in an editor.
    const lineNumber = index + 2;
    const fields = line.split(",");
    if (fields.length !== CSV_FIELD_COUNT) {
      throw new Error(
        `Wingest CSV line ${lineNumber} has ${fields.length} fields, ` +
          `expected ${CSV_FIELD_COUNT}: ${line}`,
      );
    }
    const codart = fields[0].trim();
    if (!codart) {
      throw new Error(`Wingest CSV line ${lineNumber} has an empty codart: ${line}`);
    }
    rows.push({
      codart,
      p1: fields[1],
      p2: fields[2],
      p3: fields[3],
      p4: fields[4],
      p5: fields[5],
      p6: fields[6],
      unidad: fields[7],
      unilot: fields[8],
    });
  });
  return rows;
}

function priceCents(
  text: string,
  codart: string,
  column: string,
): number | null {
  const trimmed = text.trim();
  // Number("") and Number(" ") are both 0, so an empty cell must be caught here
  // rather than falling through the numeric path as a real zero.
  if (!trimmed) return null;
  const euros = Number(trimmed);
  if (!Number.isFinite(euros) || euros < 0) {
    throw new Error(
      `Wingest price ${column} for codart ${codart} is not a valid amount: "${text}"`,
    );
  }
  // A zero tier means "no price in the ERP", not "free". NULL keeps create_order's
  // NO_PRICE gate closed; 0 cents would happily sell the product for nothing.
  // Sub-cent amounts round to 0 and are treated the same way.
  const cents = centsFromEuros(euros);
  return cents === 0 ? null : cents;
}

/** `integer` in Postgres; a factor past this would 400 the whole PATCH. */
const MAX_UNITS_PER_CASE = 2_147_483_647;

/**
 * Wingest `UNILOT` → the portal's caja factor: how many base units (bottles) one
 * caja holds. This is the number the portal MULTIPLIES a tarifa price by, so it
 * is total by construction — every input has an answer and none of them is null.
 *
 * The fallback is 1, and 1 is chosen because it is the value that CHANGES
 * NOTHING: one caja is one unit, the per-caja price equals the base price, and a
 * line total is what it was before this column meant anything. Everything the
 * ERP can hold that is not a whole number of units lands there — an empty cell,
 * a NULL column, `0` and negatives (ordinary ERP data for "not sold by the
 * case"), fractions like `6.5`, and text that is not a number at all.
 *
 * That last case USED to throw, as a canary for a CSV whose columns had shifted.
 * It no longer does, for two reasons. The canary is still posted:
 * `parseWingestPriceCsv` compares the header byte for byte and refuses any file
 * that is not this export, which catches a shifted column before a single value
 * is read. And the cost of throwing changed — this transform now runs inside the
 * nightly price-sync, which stops the WHOLE run on a raised error, so one junk
 * field in `articulo` would leave 3,000 products unpriced to protect a factor
 * whose safe fallback was one line away.
 */
function unitsPerCase(text: string): number {
  const value = Number(text.trim());
  // `Number("")` and `Number("  ")` are 0, `Number("caja")` is NaN, `Number("2.0")`
  // is 2: one test covers every shape the column can arrive in.
  if (!Number.isSafeInteger(value)) return 1;
  return value >= 1 && value <= MAX_UNITS_PER_CASE ? value : 1;
}

/**
 * One export row → one products UPDATE payload for that codart.
 *
 * `unit` is written only when the ERP gives one: the freepos import left every
 * product on the DB default 'UNIDAD', and writing 'UNIDAD' back over a blank ERP
 * unit could clobber a better value someone entered by hand.
 *
 * `is_weighed` is DERIVED here because the freepos snapshot's 需称重 column is
 * NULL on all 2976 rows, leaving the ERP unit as the only signal: unit KG means
 * the product is sold by weight. It is only ever set to TRUE — a non-KG unit
 * must not clear a flag staff may have hand-set on a product the ERP still
 * calls UNIDAD (fractional quantities depend on it; create_order rejects them
 * with BAD_QTY_STEP when is_weighed is false).
 *
 * `units_per_case` is written on EVERY row, unlike those two: the portal's
 * quantities mean cajas and its prices are per caja, so the factor is part of
 * the money and a stale one silently misprices a product. Writing it
 * unconditionally is also what makes the nightly price-sync the factor's only
 * backfill — there is no separate script and no CSV to carry.
 *
 * `syncedAt` is passed in rather than read from the clock so the transform stays
 * pure and one import run stamps a single timestamp on every row it touches.
 */
export function toWingestPricePatch(
  row: WingestPriceRow,
  syncedAt: string,
): WingestPricePatch {
  const patch: WingestPricePatch = {
    price_1_cents: priceCents(row.p1, row.codart, "p1"),
    price_2_cents: priceCents(row.p2, row.codart, "p2"),
    price_3_cents: priceCents(row.p3, row.codart, "p3"),
    price_4_cents: priceCents(row.p4, row.codart, "p4"),
    price_5_cents: priceCents(row.p5, row.codart, "p5"),
    price_6_cents: priceCents(row.p6, row.codart, "p6"),
    units_per_case: unitsPerCase(row.unilot),
    erp_synced_at: syncedAt,
  };

  const unidad = row.unidad.trim().toUpperCase();
  if (unidad) {
    patch.unit = unidad;
    if (unidad === "KG") patch.is_weighed = true;
  }
  return patch;
}

/**
 * Whether any tier survived the merge. A product with none stays VISIBLE and
 * still passes is_orderable (generated from is_available AND is_current_variant,
 * which know nothing about prices) — it fails later, inside create_order, with
 * NO_PRICE. Pricing is per-tier too, so even a product with some tiers priced is
 * NO_PRICE for a company whose tarifa lands on a NULL one.
 */
export function hasAnyPrice(patch: WingestPricePatch): boolean {
  return (
    patch.price_1_cents !== null ||
    patch.price_2_cents !== null ||
    patch.price_3_cents !== null ||
    patch.price_4_cents !== null ||
    patch.price_5_cents !== null ||
    patch.price_6_cents !== null
  );
}
