/**
 * The rules behind the category rail — the order it is drawn in, the moves that
 * change that order, and the shape of a category name — with nothing in them
 * that can touch a database.
 *
 * The reason this file exists at all is that ONE order has to serve two very
 * different screens. A restaurant sees the categories as a vertical rail beside
 * the catalogue (`/[locale]/catalogo`); a staff member sees the same list on
 * `/staff/categorias` with ↑/↓ buttons beside it. If those two ever sorted by
 * different rules, the staff member would be moving rows in a list nobody else
 * can see. So the comparator lives here and BOTH pages import it — the rail's
 * order is this page's order by construction, not by agreement.
 *
 * Everything here is pure. The actions in `app/actions/staff-categories.ts` do
 * the reading and the writing; what they get from here is the arithmetic, and
 * the arithmetic is what the tests beside this file pin down.
 */

import { localizedName } from "@/lib/catalog/display";

/**
 * The gap between two neighbours after a re-sequence.
 *
 * Ten, not one, because the numbers are written by hand elsewhere too: the
 * freepos import fills `sort_order` from the ERP's own column, and a human
 * inserting one category between two others in the database has somewhere to
 * put it. Nothing in this file depends on the step being 10 — it is the one
 * place the number is written.
 */
export const SORT_STEP = 10;

/**
 * How many categories one read of the table takes.
 *
 * 61 today — the whole freepos tree (`scripts/seed-categories.ts`) — and the
 * rail is hand-managed, so this is a guard against a runaway list, not a pager.
 *
 * It lives HERE because two places have to agree on it: `/staff/categorias`
 * draws under it and `moveCategoryAction` re-sequences under it. Two copies of
 * the number would be two bounds that could drift, and past the bound the page
 * and the action could then be looking at different rows — a row the page drew
 * and the action never saw answers its own ↑ with NOT_FOUND. Both reads also
 * `.order("id")` for the same reason: sharing a bound only means something if
 * the slice under it is the same slice.
 */
export const CATEGORY_LIMIT = 500;

/**
 * A category name is not free text: `categories_name_shape` (migration
 * 20260815000004_catalog_review_fixes.sql:33) demands a jsonb OBJECT carrying at
 * least one of `zh`/`es`, so an empty form is a constraint violation rather than
 * an empty rail entry. 60 is ours: the rail is an 88px column on a phone
 * (`catalogo/category-rail.tsx:48` — `w-[88px]`, widening to `lg:w-52` on a
 * desktop) and the admin list gives a name one line, so a name past this is not
 * a name.
 */
export const MAX_CATEGORY_NAME_LENGTH = 60;

/**
 * The jsonb this app writes into `categories.name`: one key, the other, or both.
 *
 * A type ALIAS rather than an interface, and that is load-bearing: only an alias
 * gets TypeScript's implicit index signature, so only an alias is assignable to
 * the generated `Json` type the `name` column takes. An interface here fails the
 * insert with "Index signature for type 'string' is missing".
 */
export type CategoryName = {
  zh?: string;
  es?: string;
};

/** What the comparator needs: the number, and the words this locale shows. */
export interface SortableCategory {
  sort_order: number;
  label: string;
}

/** A row as it comes back from the table, before a label has been derived. */
export interface NamedCategory {
  name: unknown;
  sort_order: number;
}

/** One row of a re-sequence: the id, and the number to write on it. */
export interface CategorySort {
  id: number;
  sort_order: number;
}

/**
 * The rail's order, as one comparison.
 *
 * Moved VERBATIM out of `catalogo/page.tsx`, comment and all, where it read:
 *
 * > Ordered here rather than in SQL: `name` is jsonb, so only the app knows
 * > which of {zh, es} this locale actually shows — and that name is the
 * > tiebreaker for the many freepos sort values that collide on one number.
 *
 * The tiebreaker is the reason `locale` is a parameter rather than a detail: 61
 * categories were imported from freepos and dozens of them share a `sort_order`
 * (the ERP's column is a text field, and most of it is empty → 0), so on a fresh
 * database the NAME decides most of the list, and `localeCompare` needs to know
 * which collation to use. `resequence` below is what eventually ends that: once
 * every row carries its own number the tie never happens and the order stops
 * depending on who is looking.
 */
export function compareCategories(
  a: SortableCategory,
  b: SortableCategory,
  locale: string,
): number {
  return a.sort_order - b.sort_order || a.label.localeCompare(b.label, locale);
}

/**
 * Rows in rail order, each carrying the label this locale shows it under.
 *
 * The label is derived HERE and not by the caller, because deriving it is half
 * of the ordering: two pages that picked their display names differently would
 * sort differently while both claiming to use the same comparator.
 */
export function sortCategories<T extends NamedCategory>(
  rows: readonly T[],
  locale: string,
): (T & { label: string })[] {
  return rows
    .map((row) => ({ ...row, label: localizedName(row.name, locale) }))
    .sort((a, b) => compareCategories(a, b, locale));
}

/** Strict 10/20/30… over an already-ordered list. */
function steps(ordered: readonly { id: number }[]): CategorySort[] {
  return ordered.map((row, index) => ({
    id: row.id,
    sort_order: (index + 1) * SORT_STEP,
  }));
}

/**
 * The list's own order, written down as numbers.
 *
 * This is what turns the freepos collisions into a real sequence. Before the
 * first write most rows sit on 0 and the NAME is what orders them; after it
 * every row carries a distinct multiple of 10 and the comparator's tiebreaker
 * never runs again — which is the point, because the tiebreaker is
 * locale-dependent and the column is not. The staff member's own locale decides
 * how the existing ties are broken, once, and after that the list reads the same
 * to everyone.
 *
 * Idempotent: run it on a list it has already numbered and every row comes back
 * with the number it already has.
 *
 * EXPORTED with no app call site today — `moveCategory` below reaches `steps`
 * directly, and the move action is the only writer. That is deliberate surface,
 * not a leftover: this is the normalization contract the move loop embeds (a
 * full 10/20/30… over the whole list, not a two-row swap), stated once where it
 * can be named, and `categories.test.ts` asserts it here rather than inferring
 * it from a move. Delete it and the contract survives only inside a loop.
 */
export function resequence<T extends NamedCategory & { id: number }>(
  rows: readonly T[],
  locale: string,
): CategorySort[] {
  return steps(sortCategories(rows, locale));
}

/** Which way a ↑/↓ button moves a row. */
export type MoveDirection = "up" | "down";

/**
 * One category, one place up or down the rail.
 *
 * Answers with the WHOLE re-sequenced list rather than the two rows that swapped
 * — the caller compares it against what it read and writes only what changed,
 * which on a list that has never been re-sequenced is nearly all of it and ever
 * after is exactly two rows.
 *
 * `null` for the two cases that are not moves: a row already at the end it is
 * being pushed towards, and an id that is not in the list at all. They are told
 * apart by the CALLER (which knows whether it saw the id) so this stays a
 * question about arithmetic.
 */
export function moveCategory<T extends NamedCategory & { id: number }>(
  rows: readonly T[],
  id: number,
  dir: MoveDirection,
  locale: string,
): CategorySort[] | null {
  const ordered = sortCategories(rows, locale);
  const from = ordered.findIndex((row) => row.id === id);
  if (from < 0) return null;

  const to = dir === "up" ? from - 1 : from + 1;
  if (to < 0 || to >= ordered.length) return null;

  const swapped = [...ordered];
  swapped[from] = ordered[to];
  swapped[to] = ordered[from];
  return steps(swapped);
}

/**
 * The `erp_code` a category created in this portal gets.
 *
 * The column is NOT NULL and UNIQUE — it is the natural key the freepos seed
 * upserts on — but nothing outside the ERP has a code to offer, so the portal
 * mints one. Every freepos code is a decimal id as text ("7", "83"), so the `p`
 * prefix cannot collide with one no matter how the ERP's numbering grows, and
 * epoch milliseconds cannot collide with an earlier portal code. Two creates
 * inside the SAME millisecond would, and the unique index is what answers that
 * — it surfaces as a DB_ERROR and the staff member presses the button again.
 *
 * The clock is a parameter so the shape can be tested without one.
 */
export function makePortalErpCode(now: Date): string {
  return `p${now.getTime()}`;
}

/** What a validated name is, or the reason there is none. */
export type NameCheck =
  | { ok: true; name: CategoryName }
  | { ok: false; code: Extract<CategoryError, "EMPTY_NAME" | "NAME_TOO_LONG"> };

/**
 * A form field as trimmed text, or "" for anything that is not a string.
 *
 * `FormData.get` is typed `string | File` and a crafted POST can send an object;
 * `String()` would turn a File into "[object File]" and let it pass a length
 * check. Same rule, and the same reason, as `user-admin.ts`'s own `text`.
 */
function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * The two name fields of the create and rename forms, as the jsonb the column
 * takes.
 *
 * Only non-empty keys are stored. `{"zh": "饮料", "es": ""}` would satisfy the
 * CHECK and then render an EMPTY rail entry for every Spanish-speaking caller —
 * `localizedName` falls back across locales only when the key is ABSENT.
 */
export function validateCategoryName(zhRaw: unknown, esRaw: unknown): NameCheck {
  const zh = text(zhRaw);
  const es = text(esRaw);

  if (
    zh.length > MAX_CATEGORY_NAME_LENGTH ||
    es.length > MAX_CATEGORY_NAME_LENGTH
  ) {
    return { ok: false, code: "NAME_TOO_LONG" };
  }
  // The CHECK's own rule, applied before the round trip rather than after it.
  if (!zh && !es) return { ok: false, code: "EMPTY_NAME" };

  const name: CategoryName = {};
  if (zh) name.zh = zh;
  if (es) name.es = es;
  return { ok: true, name };
}

/**
 * `categories.id` out of a form field.
 *
 * A bigint identity, so the wire value is a plain positive integer; anything
 * else can only come from a crafted or stale POST and would otherwise reach
 * Postgres as a cast error.
 */
export function parseCategoryId(value: unknown): number | null {
  const raw = text(value);
  if (!/^\d+$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** The ↑/↓ buttons' own field, read as a closed pair. */
export function parseMoveDirection(value: unknown): MoveDirection | null {
  const raw = text(value);
  return raw === "up" || raw === "down" ? raw : null;
}

/**
 * The 隐藏 / 显示 switch, as the two values its buttons send.
 *
 * A strict pair rather than `value === "1"`, for `user-admin.ts`'s reason: that
 * comparison turns every unexpected value — a missing field, a renamed button —
 * into "hide", and hiding a category nobody asked to hide takes it off every
 * restaurant's rail.
 */
export function parseActiveFlag(value: unknown): boolean | null {
  const raw = text(value);
  if (raw === "1") return true;
  if (raw === "0") return false;
  return null;
}

/**
 * Every failure the category surface can report, as one closed list.
 *
 * They travel back to the page as `?result=`, so the page has to prove a value
 * came from this list before using it as a message key — that is what
 * `isCategoryError` is for — and `messages.test.ts` holds both languages to it.
 * Nothing here is speculative: each code is returned by a line in
 * `app/actions/staff-categories.ts`.
 */
export const CATEGORY_ERRORS = [
  /** Neither name field survived trimming; the CHECK would refuse the row. */
  "EMPTY_NAME",
  /** One of them is past `MAX_CATEGORY_NAME_LENGTH`. */
  "NAME_TOO_LONG",
  /** An id, a direction or a flag that this page could not have produced. */
  "BAD_INPUT",
  /** The id is well-formed and matches no category — a stale open page. */
  "NOT_FOUND",
  /** ↑ on the first row, or ↓ on the last one. */
  "EDGE",
  "DB_ERROR",
] as const;

export type CategoryError = (typeof CATEGORY_ERRORS)[number];

export function isCategoryError(value: string): value is CategoryError {
  return (CATEGORY_ERRORS as readonly string[]).includes(value);
}

/**
 * What a REJECTED create hands back to the form it came from.
 *
 * The row actions redirect with `?result=`; the create form cannot, for the
 * house reason `user-admin.ts` states at length: a redirect remounts the page
 * and blanks every field, so a staff member who typed a Chinese name and forgot
 * the Spanish one would retype both. `useActionState` keeps this instead, and
 * the values in it are the `defaultValue`s the form's post-action reset lands on.
 *
 * A SUCCESS carries no values — the fields go back to empty for the next
 * category — and `ok` is what the form draws its confirmation from. It does not
 * redirect: the action revalidates, the list beside the form redraws with the
 * new (hidden) category in it, and the form stays open for the next one.
 */
export interface CategoryFormState {
  ok: boolean;
  code: CategoryError | null;
  values: { zh: string; es: string } | null;
}

/** What `useActionState` mounts with: no attempt made, nothing to restore. */
export const EMPTY_CATEGORY_FORM_STATE: CategoryFormState = {
  ok: false,
  code: null,
  values: null,
};
