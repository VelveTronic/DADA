import { parseSku } from "@/lib/catalog/sku";
import { centsFromEuros } from "@/lib/money";

export const FREEPOS_IMPORT_COLUMNS = [
  "编号",
  "名称",
  "名称2",
  "售价",
  "售价2",
  "售价3",
  "售价4",
  "售价5",
  "售价6",
  "税率",
  "断货",
  "需称重",
  "App隐藏",
  "APP多规格(逗号分隔)",
] as const;

export type FreeposImportColumn = (typeof FREEPOS_IMPORT_COLUMNS)[number];
export type FreeposImportRow = Record<FreeposImportColumn, string | null>;

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (cause) {
    throw new Error("Freepos snapshot must be valid UTF-8", { cause });
  }
}

function normalizeCell(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }
  throw new Error("Freepos import cells must be strings, numbers, or null");
}

/**
 * Decode a Freepos snapshot explicitly as UTF-8 and immediately project every
 * row to the import contract. Notes and other internal columns never leave this
 * boundary.
 */
export function parseFreeposImportSnapshot(
  bytes: Uint8Array,
): FreeposImportRow[] {
  let document: unknown;
  try {
    document = JSON.parse(decodeUtf8(bytes));
  } catch (cause) {
    if (cause instanceof Error && cause.message.includes("valid UTF-8")) {
      throw cause;
    }
    throw new Error("Freepos snapshot must contain valid JSON", { cause });
  }

  if (
    !document ||
    typeof document !== "object" ||
    !Array.isArray((document as { header?: unknown }).header) ||
    !Array.isArray((document as { rows?: unknown }).rows)
  ) {
    throw new Error("Freepos snapshot must contain header and rows arrays");
  }

  const { header, rows } = document as { header: unknown[]; rows: unknown[] };
  if (!header.every((value): value is string => typeof value === "string")) {
    throw new Error("Freepos header values must be strings");
  }

  const indices = new Map<FreeposImportColumn, number>();
  for (const column of FREEPOS_IMPORT_COLUMNS) {
    const matches = header.flatMap((value, index) =>
      value === column ? [index] : [],
    );
    if (matches.length !== 1) {
      throw new Error(
        `Freepos column "${column}" must occur exactly once; found ${matches.length}`,
      );
    }
    indices.set(column, matches[0]);
  }

  return rows.map((candidate, rowIndex) => {
    if (!Array.isArray(candidate) || candidate.length !== header.length) {
      throw new Error(
        `Freepos row ${rowIndex + 1} does not match the header width`,
      );
    }

    return Object.fromEntries(
      FREEPOS_IMPORT_COLUMNS.map((column) => [
        column,
        normalizeCell(candidate[indices.get(column)!]),
      ]),
    ) as FreeposImportRow;
  });
}

function euroTextToCents(value: string | null): number | null {
  if (value === null) return null;
  const euros = Number(value);
  if (!Number.isFinite(euros) || euros < 0) {
    throw new Error(`Invalid Freepos price: ${value}`);
  }
  return centsFromEuros(euros);
}

function taxTextToPercent(value: string | null): number {
  if (value === null) throw new Error("Freepos tax rate is required");
  const raw = Number(value);
  if (!Number.isFinite(raw) || raw < 0) {
    throw new Error(`Invalid Freepos tax rate: ${value}`);
  }
  const percent = raw <= 1 ? raw * 100 : raw;
  if (![4, 10, 21].includes(percent)) {
    throw new Error(`Unsupported Freepos tax rate: ${value}`);
  }
  return percent;
}

/** Convert only unambiguous SKU, price, and tax fields to database units. */
export function toFreeposSkuPricing(row: FreeposImportRow) {
  const codart = row["编号"]?.trim();
  if (!codart) throw new Error("Freepos product number is required");
  const { base, suffix } = parseSku(codart);

  return {
    codart,
    base_sku: base,
    variant_suffix: suffix,
    price_1_cents: euroTextToCents(row["售价"]),
    price_2_cents: euroTextToCents(row["售价2"]),
    price_3_cents: euroTextToCents(row["售价3"]),
    price_4_cents: euroTextToCents(row["售价4"]),
    price_5_cents: euroTextToCents(row["售价5"]),
    price_6_cents: euroTextToCents(row["售价6"]),
    iva_rate: taxTextToPercent(row["税率"]),
  };
}
