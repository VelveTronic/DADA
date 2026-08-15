import type { FreeposImportRow } from "@/lib/catalog/freepos";
import { parseSku } from "@/lib/catalog/sku";

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff]/;
const LATIN = /[A-Za-z]/;
/** Separators that only ever glued the two language segments together. */
const EDGE_SEPARATORS = /^[\s\-–—:：·,，/|]+|[\s\-–—:：·,，/|]+$/g;
/** Freepos marks a product dead by prefixing its name: 断货 / (断货) / 取消 / 停产. */
const UNAVAILABLE_PREFIX =
  /^[(（]?\s*(?:断货|取消|停产)\s*[)）]?\s*[-–—:：]?\s*/;

export interface BilingualName {
  zh: string | null;
  es: string | null;
}

type NameLanguage = "zh" | "es";

function joinSegment(tokens: string[]): string | null {
  return tokens.join(" ").replace(EDGE_SEPARATORS, "").trim() || null;
}

/**
 * Freepos stores both languages in one field. The snapshot has no dominant
 * head language (1791 of 2419 mixed names start in Spanish, 628 in Chinese)
 * and 678 of them alternate more than once ("PUERROS C/APROX 10KG 大葱 POR
 * KILO"), so a head/tail rule cannot work. Split per whitespace token instead:
 * a token holding any CJK character belongs to zh (sizes and latin fragments
 * glued inside it, "咖喱角10/1.2KG", stay with zh), any other token holding a
 * latin letter belongs to es, and a token with neither follows its predecessor.
 * Each side keeps its original order; separators left at an edge are trimmed.
 */
export function splitBilingualName(raw: string): BilingualName {
  const cleaned = raw.trim().replace(/\s+/g, " ");
  if (!cleaned) return { zh: null, es: null };

  const zh: string[] = [];
  const es: string[] = [];
  let previous: NameLanguage = "es";
  for (const token of cleaned.split(" ")) {
    // Annotated: without it the assignment below makes the inference circular.
    const language: NameLanguage = CJK.test(token)
      ? "zh"
      : LATIN.test(token)
        ? "es"
        : previous;
    (language === "zh" ? zh : es).push(token);
    previous = language;
  }

  return { zh: joinSegment(zh), es: joinSegment(es) };
}

export interface ImportedProduct {
  codart: string;
  base_sku: string;
  variant_suffix: string;
  is_current_variant: boolean;
  name: { zh?: string; es?: string };
  unit: string;
  is_weighed: boolean;
  is_available: boolean;
  iva_rate: number;
}

function flag(value: string | null): boolean {
  return value !== null && value.trim() !== "" && value.trim() !== "0";
}

function ivaPercent(value: string | null): number {
  if (value === null) throw new Error("Freepos tax rate is required");
  const raw = Number(value);
  if (!Number.isFinite(raw) || raw < 0) {
    throw new Error(`Invalid Freepos tax rate: ${value}`);
  }
  const percent = raw <= 1 ? Math.round(raw * 100) : Math.round(raw);
  if (![4, 10, 21].includes(percent)) {
    throw new Error(`Unsupported Freepos tax rate: ${value}`);
  }
  return percent;
}

/**
 * One freepos row → one products record. NO price fields on purpose: freepos
 * prices are garbage (5/2976 non-zero); tiers stay NULL until the Wingest merge,
 * and create_order's NO_PRICE gate keeps un-priced products un-orderable.
 * 名称2 is ignored: the two rows that fill it hold "3", not a second name.
 * is_current_variant defaults true here; selectCurrentVariants finalizes it.
 */
export function toProductRecord(row: FreeposImportRow): ImportedProduct {
  const codart = row["编号"]?.trim();
  if (!codart) throw new Error("Freepos product number is required");
  const { base, suffix } = parseSku(codart);

  const rawName = (row["名称"] ?? "").trim();
  if (!rawName) throw new Error(`Freepos name is required for ${codart}`);
  const unavailableByName = UNAVAILABLE_PREFIX.test(rawName);
  const { zh, es } = splitBilingualName(rawName.replace(UNAVAILABLE_PREFIX, ""));
  const name: { zh?: string; es?: string } = {};
  if (zh) name.zh = zh;
  if (es) name.es = es;
  if (!name.zh && !name.es) {
    throw new Error(`Unsplittable Freepos name for ${codart}: ${rawName}`);
  }

  return {
    codart,
    base_sku: base,
    variant_suffix: suffix,
    is_current_variant: true,
    name,
    unit: "UNIDAD",
    is_weighed: flag(row["需称重"]),
    is_available: !unavailableByName && !flag(row["App隐藏"]),
    iva_rate: ivaPercent(row["税率"]),
  };
}

/**
 * Exactly one current variant per base_sku:
 * available beats unavailable → suffixless beats suffixed → lowest suffix wins.
 * Deterministic and total; ties cannot survive.
 */
export function selectCurrentVariants(
  products: ImportedProduct[],
): ImportedProduct[] {
  const byBase = new Map<string, ImportedProduct[]>();
  for (const product of products) {
    const group = byBase.get(product.base_sku);
    if (group) group.push(product);
    else byBase.set(product.base_sku, [product]);
  }

  const rank = (product: ImportedProduct): string =>
    `${product.is_available ? 0 : 1}|${product.variant_suffix === "" ? 0 : 1}|${product.variant_suffix}`;

  for (const group of byBase.values()) {
    let winner = group[0];
    for (const product of group) {
      if (rank(product) < rank(winner)) winner = product;
    }
    for (const product of group) product.is_current_variant = product === winner;
  }
  return products;
}
