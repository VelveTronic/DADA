/** UI-side helpers for the bilingual catalog. Pure, no I/O. */

/** Pick the display name for a locale from a jsonb {"zh","es"} value; fall back across locales. */
export function localizedName(name: unknown, locale: string): string {
  if (!name || typeof name !== "object" || Array.isArray(name)) return "";
  const n = name as Record<string, unknown>;
  const zh = typeof n.zh === "string" ? n.zh : null;
  const es = typeof n.es === "string" ? n.es : null;
  return (locale === "zh" ? (zh ?? es) : (es ?? zh)) ?? "";
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
