/**
 * A form field as trimmed text, or "" for anything that is not a string.
 *
 * `FormData.get` is typed `string | File` and a crafted POST can send a file
 * part, which `String()` would turn into the 13-character "[object File]" — a
 * value that passes a non-empty check, passes a length check, and reaches the
 * database. Non-strings are simply absent instead.
 *
 * It takes `unknown` rather than `FormDataEntryValue | null` because two of its
 * three callers hand it a value that has already been widened (a `useActionState`
 * field, a parser argument), and the narrowing is the whole point: the wider the
 * door, the more it is worth having one.
 *
 * This was three byte-identical private copies — `staff-products.ts`,
 * `lib/categories.ts`, `lib/user-admin.ts` — and it is one now. The fourth
 * lookalike, `raw` in `app/actions/staff-categories.ts`, is NOT this function
 * and stays where it is: it deliberately does not trim, so a rejected create can
 * redraw the fields exactly as they were typed.
 */
export function formText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
