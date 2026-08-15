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

/** One raw CSV line, still in ERP units (euro text, ERP unit names). */
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
 */
export interface WingestPricePatch {
  price_1_cents: number | null;
  price_2_cents: number | null;
  price_3_cents: number | null;
  price_4_cents: number | null;
  price_5_cents: number | null;
  price_6_cents: number | null;
  units_per_case: number | null;
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

function unitsPerCase(text: string, codart: string): number | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const value = Number(trimmed);
  // Non-numeric UNILOT means the file is not shaped the way we think it is;
  // silently nulling it would hide that. Zero and negatives are ordinary ERP
  // data ("not sold by the case") and products_units_per_case_pos rejects them,
  // so those become NULL instead of an error.
  if (!Number.isFinite(value)) {
    throw new Error(
      `Wingest units-per-case (UNILOT) for codart ${codart} is not a number: "${text}"`,
    );
  }
  return value > 0 ? value : null;
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
    units_per_case: unitsPerCase(row.unilot, row.codart),
    erp_synced_at: syncedAt,
  };

  const unidad = row.unidad.trim().toUpperCase();
  if (unidad) {
    patch.unit = unidad;
    if (unidad === "KG") patch.is_weighed = true;
  }
  return patch;
}

/** A product with no surviving tier stays un-orderable after the merge. */
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
