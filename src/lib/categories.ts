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
import { formText } from "@/lib/form-text";

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
 * EXPORTED with no app call site today — `moveCategoryInTree` below reaches
 * `steps` directly (over the FLATTENED tree rather than this flat sort), and
 * the move action is the only writer. That is deliberate surface, not a
 * leftover: this is the normalization contract the move loop embeds (a full
 * 10/20/30… over the whole list, not a two-row swap), stated once where it can
 * be named, and `categories.test.ts` asserts it here rather than inferring it
 * from a move.
 */
export function resequence<T extends NamedCategory & { id: number }>(
  rows: readonly T[],
  locale: string,
): CategorySort[] {
  return steps(sortCategories(rows, locale));
}

/** A row that can be grouped: `parent_label` beside the sortable pair. */
export interface GroupableCategory extends NamedCategory {
  parent_label: unknown;
}

/**
 * One entry of the two-level rail: a plain category, or a group heading with
 * its children in rail order under it.
 */
export type CategoryTreeEntry<T> =
  | { kind: "category"; category: T & { label: string } }
  | { kind: "group"; label: string; children: (T & { label: string })[] };

/**
 * The 一级/二级 view of the flat table (owner, 2026-08-20), derived rather
 * than stored: `parent_label` — seeded from the freepos tree and edited on
 * /staff/categorias — is the GROUPING KEY, and rows sharing one become the
 * children of a heading that carries it. No parent rows exist and none are
 * invented; the hierarchy is a way of READING the same 61 rows, which is why
 * this lives beside `sortCategories` and reuses its comparator wholesale.
 *
 * The rules, each one pinned by a test:
 * - a group forms at TWO members or more. A lone row whose parent label is
 *   itself — most of the freepos tree — or whose label nobody else shares
 *   renders flat: a heading over one row says nothing the row does not.
 * - membership is by label equality in THIS locale, the same equality the
 *   staff page writes (children of 餐厅用品 include the row NAMED 餐厅用品 —
 *   the freepos shape where a group repeats itself as its own child).
 * - a row with no parent label (null, `{}`, empty strings) is its own entry.
 * - groups and flat rows interleave by the rail's own order: a group sits
 *   where its FIRST child (by `compareCategories`) would have sat, so turning
 *   a label into a group never teleports its rows down the rail.
 */
export function groupCategories<T extends GroupableCategory>(
  rows: readonly T[],
  locale: string,
): CategoryTreeEntry<T>[] {
  const labeled = sortCategories(rows, locale);

  const buckets = new Map<string, (T & { label: string })[]>();
  const flat: (T & { label: string })[] = [];
  for (const row of labeled) {
    const parent = localizedName(row.parent_label, locale);
    if (!parent) {
      flat.push(row);
      continue;
    }
    const bucket = buckets.get(parent);
    if (bucket) bucket.push(row);
    else buckets.set(parent, [row]);
  }

  const entries: { order: T & { label: string }; entry: CategoryTreeEntry<T> }[] =
    [];
  for (const row of flat) {
    entries.push({ order: row, entry: { kind: "category", category: row } });
  }
  for (const [label, children] of buckets) {
    if (children.length === 1) {
      // Not a group yet — see the rules above.
      entries.push({
        order: children[0],
        entry: { kind: "category", category: children[0] },
      });
    } else {
      entries.push({
        order: children[0],
        entry: { kind: "group", label, children },
      });
    }
  }

  return entries
    .sort((a, b) => compareCategories(a.order, b.order, locale))
    .map(({ entry }) => entry);
}

/**
 * Which categories THIS caller must not see: the 'selected' ones whose
 * allowlist does not include them. Everything else — 'all' rows, and
 * 'selected' rows the caller is on — passes.
 *
 * Pure and read-only so the two customer surfaces (catalogue and search)
 * cannot disagree: both compute their hidden set through this one function
 * from the same two reads (the category list, and the caller's own
 * `category_companies` rows — RLS hands a restaurant only its own).
 */
export function hiddenCategoryIds(
  categories: readonly { id: number; visibility: string }[],
  allowedIds: ReadonlySet<number>,
): number[] {
  return categories
    .filter((row) => row.visibility === "selected" && !allowedIds.has(row.id))
    .map((row) => row.id);
}

/**
 * What the 一级分类 field's text means as a `parent_label` value.
 *
 * The staff form offers the EXISTING parent labels in a datalist, and typing
 * one back — in either language — must reuse that label's stored jsonb rather
 * than mint a lookalike: `groupCategories` groups by label equality per
 * locale, so a fresh `{zh: "餐厅用品", es: "餐厅用品"}` beside a stored
 * `{zh: "餐厅用品", es: "Menaje"}` reads as ONE group in Chinese and TWO in
 * Spanish. Matching is exact on either language key, against the labels that
 * are already in the table.
 *
 * Text that matches nothing is a NEW label, written to both keys so it renders
 * the same in both languages until a translation exists. Rows do not share the
 * object — each keeps its own copy — which is exactly why reuse-on-match
 * matters. Empty text files the row under no group at all.
 */
export function resolveParentLabel(
  input: string,
  existing: readonly unknown[],
): CategoryName | null {
  const wanted = input.trim();
  if (!wanted) return null;
  for (const label of existing) {
    if (!label || typeof label !== "object" || Array.isArray(label)) continue;
    const record = label as Record<string, unknown>;
    if (record.zh === wanted || record.es === wanted) {
      // The stored value verbatim. Narrowed by reading, not by trusting: the
      // column is unconstrained jsonb, so only the string keys come along.
      const kept: CategoryName = {};
      if (typeof record.zh === "string") kept.zh = record.zh;
      if (typeof record.es === "string") kept.es = record.es;
      return kept;
    }
  }
  return { zh: wanted, es: wanted };
}

/** The two words `categories.visibility` accepts, or null for anything else. */
export function parseVisibility(value: unknown): "all" | "selected" | null {
  return value === "all" || value === "selected" ? value : null;
}

/** Which way a ↑/↓ button moves a row. */
export type MoveDirection = "up" | "down";

/**
 * What a tree move points at: one category row by id, or one 一级 group by the
 * label this locale shows — the same identity `groupCategories` groups by.
 */
export type TreeMoveTarget = { id: number } | { group: string };

/** A tree move's answer: the numbers to write, or the reason there are none. */
export type TreeMoveResult =
  | { ok: true; sorts: CategorySort[] }
  | { ok: false; code: "EDGE" | "NOT_FOUND" };

/**
 * One entry, one place up or down the TREE the customer actually scrolls
 * (owner, 2026-08-21: the flat arrows could not reorder the 一级 groups at
 * all — a group sits where its first child sits, so moving it meant marching
 * every child past every child of its neighbour).
 *
 * The move happens in the DERIVED tree — `groupCategories`, the same
 * derivation the rail and both product selects draw — and what comes back is
 * that tree FLATTENED into `sort_order` numbers: each top-level entry in
 * order, a group contributing its children as one contiguous block. Three
 * moves exist and each is one swap:
 *
 *  - a group, among the top-level entries (past standalones and other groups
 *    alike);
 *  - a standalone category, among the same top-level entries;
 *  - a child, WITHIN its group only. The top of a group answers ↑ with EDGE —
 *    arrows never move a row between groups, because that is a REFILING, and
 *    the 一级分类 field on the edit form is where filing is decided.
 *
 * Flatten-then-`steps` re-sequences the WHOLE list every time, which is what
 * makes the derived tree of the new numbers equal the intended tree: after
 * one write every group's children are contiguous, the group's position IS
 * its first child's number, and later moves change only the two blocks that
 * swapped (the caller writes only changed rows, as ever). On a legacy list —
 * scattered children, freepos ties — the FIRST move rewrites nearly
 * everything, once, exactly as the flat `resequence` always did.
 *
 * Group identity is the label in the CALLER's locale. Two locales can bucket
 * the freepos seeds identically, so this is the same word the staff member
 * pressed the arrow beside.
 */
export function moveCategoryInTree<
  T extends GroupableCategory & { id: number },
>(
  rows: readonly T[],
  target: TreeMoveTarget,
  dir: MoveDirection,
  locale: string,
): TreeMoveResult {
  const entries = groupCategories(rows, locale);
  const step = dir === "up" ? -1 : 1;
  const flatten = (list: readonly CategoryTreeEntry<T>[]): CategorySort[] =>
    steps(
      list.flatMap((entry) =>
        entry.kind === "group" ? entry.children : [entry.category],
      ),
    );
  const swapTop = (from: number): TreeMoveResult => {
    const to = from + step;
    if (to < 0 || to >= entries.length) return { ok: false, code: "EDGE" };
    const next = [...entries];
    next[from] = entries[to];
    next[to] = entries[from];
    return { ok: true, sorts: flatten(next) };
  };

  if ("group" in target) {
    const from = entries.findIndex(
      (entry) => entry.kind === "group" && entry.label === target.group,
    );
    if (from < 0) return { ok: false, code: "NOT_FOUND" };
    return swapTop(from);
  }

  const topIndex = entries.findIndex(
    (entry) => entry.kind === "category" && entry.category.id === target.id,
  );
  if (topIndex >= 0) return swapTop(topIndex);

  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (entry.kind !== "group") continue;
    const from = entry.children.findIndex((child) => child.id === target.id);
    if (from < 0) continue;
    const to = from + step;
    if (to < 0 || to >= entry.children.length) {
      return { ok: false, code: "EDGE" };
    }
    const children = [...entry.children];
    children[from] = entry.children[to];
    children[to] = entry.children[from];
    const next = [...entries];
    next[index] = { ...entry, children };
    return { ok: true, sorts: flatten(next) };
  }
  return { ok: false, code: "NOT_FOUND" };
}

/**
 * The one `?cat=` word that is not an `erp_code`: the products nobody filed.
 *
 * **Collision-safe by the WRITERS, not by the schema.** `categories.erp_code` is
 * a plain unique text column, so nothing in Postgres would refuse a category
 * literally coded `none`. What refuses it is that the app has exactly two
 * writers and neither can mint one. All 61 freepos codes are decimal digit
 * strings ("7", "83"), and `pnpm seed:categories` upserts on that same hard-coded
 * table, so re-running it can only ever write those 61 again; a category created
 * in this portal gets `makePortalErpCode` below, which is always `p<epoch-ms>`.
 * A hand-written INSERT straight into the database could still break it, and
 * that is the whole exposure.
 */
export const CAT_NONE = "none";

/** What `resolveCatFilter` looks a `?cat=` word up in. */
export interface CatCode {
  id: number;
  erp_code: string;
}

/**
 * What `?cat=` resolved to: no filter at all, the products nobody filed, or one
 * category's id.
 *
 * `null` is also where an `erp_code` that matches no category lands — the
 * customer catalogue's own precedent for an unknown `?cat=` (`catalogo/page.tsx`
 * resolves it "to nothing and the page renders unfiltered, never a failed
 * query"), and the same rule keeps a stale bookmark from emptying a table.
 */
export type CatFilter = { kind: "none" } | { kind: "id"; id: number } | null;

/**
 * Whether resolving `?cat=` needs the category list at all.
 *
 * TRUE only for a word that has to be LOOKED UP. `resolveCatFilter` below is
 * written AROUND this predicate — `categories` is read only inside its `true`
 * branch — so `resolveCatFilter(catParam, [])` and
 * `resolveCatFilter(catParam, realList)` are provably the same value whenever
 * this returns false. That is what lets `/staff/productos` put the products
 * query on the wire beside the category read instead of behind it, and it is why
 * the two answers cannot drift apart: there is one rule, in one place, and the
 * page's eager path is a CALL to it rather than a copy of it.
 *
 * (They did drift. The page shipped with `needsCategories` false for `none` —
 * correct — and then raced a hard-coded unfiltered query, so the 未分类 view
 * returned the whole table.)
 */
export function catNeedsCategories(catParam: string): boolean {
  return catParam !== "" && catParam !== CAT_NONE;
}

/**
 * `?cat=` as a filter over `products.category_id`.
 *
 * Four inputs, three answers: "" is no filter, `none` is the unfiled products,
 * a known `erp_code` is that category's id, and anything else — a junk word, a
 * retired code, a category past `CATEGORY_LIMIT` — is no filter again.
 *
 * `erp_code` and not `id` is the URL vocabulary of BOTH halves of the portal, so
 * a staff member can paste a restaurant's catalogue link into the staff table
 * and see the same slice.
 */
export function resolveCatFilter(
  catParam: string,
  categories: readonly CatCode[],
): CatFilter {
  if (!catNeedsCategories(catParam)) {
    return catParam === CAT_NONE ? { kind: "none" } : null;
  }
  const match = categories.find((c) => c.erp_code === catParam);
  return match ? { kind: "id", id: match.id } : null;
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
 * The local name for the shared `formText` (`lib/form-text.ts`): a form field as
 * trimmed text, or "" for anything that is not a string.
 *
 * An alias rather than a rename at every call site — this file's parsers below
 * read as arithmetic and `text(value)` is how they have always read.
 */
const text = formText;

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
