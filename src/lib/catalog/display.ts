/** UI-side helpers for the bilingual catalog. Pure, no I/O. */

/** Pick the display name for a locale from a jsonb {"zh","es"} value; fall back across locales. */
export function localizedName(name: unknown, locale: string): string {
  if (!name || typeof name !== "object" || Array.isArray(name)) return "";
  const n = name as Record<string, unknown>;
  // {"zh": null} is DB-legal: products_name_shape checks key existence only.
  const zh = typeof n.zh === "string" ? n.zh : null;
  const es = typeof n.es === "string" ? n.es : null;
  return (locale === "zh" ? (zh ?? es) : (es ?? zh)) ?? "";
}

/**
 * The unit cell under a product name: `CAJA` on its own, `CAJA×24` when one
 * caja really holds 24 base units.
 *
 * Portal quantities mean CAJAS and the price beside them is the price of one
 * caja, so the factor is the one piece of that sentence a restaurant cannot
 * infer: `CAJA · 12,00 €` and `CAJA×24 · 12,00 €` are very different offers.
 *
 * The suffix appears ONLY above 1. A factor of 1 is the column's default and its
 * fallback for everything the ERP could not answer, so `UNIDAD×1` would be a
 * claim about the packaging that nobody made — and on 2,172 of 2,971 products it
 * would be noise on every row.
 */
export function unitLabel(
  unit: string | null | undefined,
  unitsPerCase: number | null | undefined,
): string {
  const label = unit ?? "";
  // The view widens every column to `| null`, so both halves can arrive missing.
  // No unit means there is nothing for the factor to qualify — a bare `×24` in
  // the meta line would be 24 of nothing — and a factor that is not a whole
  // number above 1 has nothing to say. The DB constraint makes both unreachable;
  // that is exactly why neither may reach a customer's screen if it happens.
  if (
    !label ||
    typeof unitsPerCase !== "number" ||
    !Number.isInteger(unitsPerCase)
  ) {
    return label;
  }
  return unitsPerCase > 1 ? `${label}×${unitsPerCase}` : label;
}

/**
 * Make a user query safe to embed in a PostgREST or() ilike pattern:
 * drop the characters PostgREST parses (comma, parens, percent, dot leaders),
 * collapse whitespace, cap length.
 */
export function sanitizeSearch(raw: string): string {
  return raw
    .replace(/[,()%*.\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40)
    .trim();
}
