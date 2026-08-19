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
 * Make a user query safe to embed in a PostgREST or() ilike pattern: drop the
 * characters the `or()` grammar parses (comma, parens, dot leaders) and the ones
 * LIKE reads as pattern syntax — `%` and `_`, its any-run and any-ONE wildcards,
 * `*` (PostgREST's spelling of `%`) and the `\` that escapes them. `_` is the
 * quiet one: left in, `a_c` silently matches `abc` as well as the codart the
 * customer typed. Then collapse whitespace and cap length.
 *
 * Stripped rather than escaped, so the query is only ever read literally, and
 * whatever survives is also what the field is redrawn with and what the search
 * history stores.
 */
export function sanitizeSearch(raw: string): string {
  return raw
    .replace(/[,()%*._\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40)
    .trim();
}
