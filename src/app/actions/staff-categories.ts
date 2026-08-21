"use server";

import { hasLocale } from "next-intl";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { routing } from "@/i18n/routing";
import { assertStaff } from "@/lib/auth/assert-staff";
import type { CategoryError, CategoryFormState } from "@/lib/categories";
import {
  CATEGORY_LIMIT,
  makePortalErpCode,
  MAX_CATEGORY_NAME_LENGTH,
  moveCategory,
  parseActiveFlag,
  parseCategoryId,
  parseMoveDirection,
  parseVisibility,
  resolveParentLabel,
  SORT_STEP,
  validateCategoryName,
} from "@/lib/categories";
import { createServerSupabase } from "@/lib/supabase/server";

/**
 * 分类管理's five writes — and the only writes in this app that a staff member
 * performs with their OWN credentials.
 *
 * **Why there is no RPC here, and no service-role client.** `public.categories`
 * is the one table the security hardening left open to an authenticated staff
 * session: the three write policies gate on `private.is_staff()`
 * (`supabase/migrations/20260815101406_security_order_integrity.sql:156-164`),
 * the table grant carries `insert, update, delete … to authenticated` (:688) and
 * the identity sequence is usable by the same role (:719). `category_companies`
 * (migration 20260820190000) was cut to the same shape on purpose — staff
 * policy, per-role grants, no RPC. So the DATABASE is the gate on every
 * statement below, under the caller's own JWT, and no new SECURITY DEFINER
 * function exists — which is why the accepted security-advisor baseline in
 * CLAUDE.md is unchanged by any of it.
 *
 * `assertStaff` (`lib/auth/assert-staff.ts`, shared with the products and orders
 * actions) is not that gate. It is the early, kinder half: a Server Action is
 * its own POST endpoint, reachable by anyone who knows the action id without
 * ever rendering the page, and a caller who gets that far should be stopped
 * here rather than one round trip later. If it were ever removed, RLS would
 * still refuse every statement in this file.
 *
 * Products are the deliberate contrast: `staff-products.ts` writes with the
 * SERVICE-ROLE client because the six price columns are revoked from
 * authenticated outright. Do not move a write between the two mechanisms.
 */

/** The locale arrives in a form field, so it is never trusted as a path segment. */
function safeLocale(value: FormDataEntryValue | null) {
  const candidate = String(value ?? routing.defaultLocale);
  return hasLocale(routing.locales, candidate)
    ? candidate
    : routing.defaultLocale;
}

/**
 * Every path the rail's order or wording can reach, cleared at once.
 *
 * Both pages are `force-dynamic`, so the SERVER re-reads on the next request
 * regardless; what this clears is the client-side Router Cache, which is the
 * copy that would otherwise let somebody navigate BACK to a catalogue rendered
 * from the old order. Both locales, because the staff member's language is not
 * the restaurant's — a rename in the zh back office has to reach the es rail.
 *
 * `/staff/productos` is on the list because that page draws this table too: its
 * 分类 column is a `<select>` of every category, so a rename changes the option
 * labels and a hide/show moves the （已隐藏） marker on one of them. Nothing
 * there is invalidated by a MOVE, but the four writes share one revalidation
 * for the same reason they share one file — a caller that had to pick would
 * eventually pick wrong.
 */
function revalidateCategoryPaths() {
  for (const locale of routing.locales) {
    revalidatePath(`/${locale}/staff/categorias`);
    revalidatePath(`/${locale}/staff/productos`);
    revalidatePath(`/${locale}/catalogo`);
    // Search filters by the same visibility the catalogue does (owner,
    // 2026-08-20), so a grant change has to clear its cached copy too.
    revalidatePath(`/${locale}/buscar`);
  }
}

/**
 * The page's own view state, read back off the form that was submitted.
 *
 * Two independent things, and BOTH have to survive a row action: which category
 * is open in the detail pane, and whether the create card is out. They are
 * hidden fields rather than referer parsing because the page is the only thing
 * that knows them, and it already writes the same pair into its links
 * (`pageHref` in `staff/categorias/page.tsx`).
 */
interface ViewState {
  /** The `?cat=` the form was rendered under, "" for none. */
  cat: string;
  /** Whether `?new=1` was on the URL that drew the form. */
  creating: boolean;
}

function viewState(formData: FormData): ViewState {
  const id = parseCategoryId(formData.get("cat"));
  return {
    cat: id === null ? "" : String(id),
    // The literal "1" and nothing else — the one value `pageHref` writes and
    // the page reads. Anything else simply closes the card, which is the safe
    // reading of a field a crafted POST controls.
    creating: formData.get("new") === "1",
  };
}

/**
 * Where a finished (or refused) row action lands: back on the page it came
 * from, carrying the one word it needs to draw its banner — the `?result=<CODE>`
 * convention `staff-users.ts`, `staff-orders.ts` and `staff-settings.ts` share —
 * plus the view state above, so neither the detail pane nor a half-typed create
 * card is thrown away by pressing ↑ on a row.
 *
 * Returns `never` because `redirect()` works by THROWING NEXT_REDIRECT, which is
 * why no call to it may sit inside a catch-all try.
 */
function finish(
  locale: string,
  result: "ok" | CategoryError,
  view: ViewState,
): never {
  revalidateCategoryPaths();
  const params = new URLSearchParams({ result });
  if (view.cat) params.set("cat", view.cat);
  if (view.creating) params.set("new", "1");
  redirect(`/${locale}/staff/categorias?${params}`);
}

/**
 * Create a category. Hidden.
 *
 * Hidden is not a default anybody may change without changing the copy beside
 * the form: a brand-new category has no products in it, and an empty entry
 * appearing on every restaurant's rail the moment a staff member types a name is
 * the confusing half of this feature. So it is created with `is_active = false`,
 * the form says so, and 显示 is a separate, deliberate press.
 *
 * `sort_order` is max + one step, which puts it at the BOTTOM of the list — the
 * only position that is not a claim about where it belongs. ↑ moves it from
 * there. Read-then-write, so two staff members creating a category at the same
 * moment can land on the same number; nothing breaks (the column is not unique
 * and the comparator settles ties by name) and the first ↑/↓ re-sequences both.
 *
 * Answers the FORM instead of redirecting — see `CategoryFormState`.
 */
export async function createCategory(
  _prevState: CategoryFormState,
  formData: FormData,
): Promise<CategoryFormState> {
  await assertStaff();

  // Kept exactly as typed — untrimmed — so a rejected create can redraw the
  // fields it was sent rather than blanking both of them. Untrimmed is the ONLY
  // difference from `renameCategory`, which hands `validateCategoryName` the raw
  // entries because it has nothing to redraw.
  //
  // Not `String(...)`: `FormData.get` is typed `string | File` and a crafted
  // POST can send a file part, which `String()` would turn into the 13-character
  // "[object File]" — a name that passes every check below and lands in the
  // column. Same rule, and the same reason, as `text()` in `lib/categories.ts`.
  const raw = (value: FormDataEntryValue | null) =>
    typeof value === "string" ? value : "";
  const zhRaw = raw(formData.get("name_zh"));
  const esRaw = raw(formData.get("name_es"));
  const values = { zh: zhRaw, es: esRaw };

  const checked = validateCategoryName(zhRaw, esRaw);
  if (!checked.ok) return { ok: false, code: checked.code, values };

  const supabase = await createServerSupabase();
  const { data: last, error: maxError } = await supabase
    .from("categories")
    .select("sort_order")
    .order("sort_order", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (maxError) {
    console.error("createCategory max sort_order:", maxError);
    return { ok: false, code: "DB_ERROR", values };
  }

  const { error } = await supabase.from("categories").insert({
    name: checked.name,
    // The one column the ERP would normally own. See `makePortalErpCode`: the
    // `p` prefix is what keeps a portal code out of freepos's number space, and
    // the UNIQUE index is what answers two creates in the same millisecond.
    erp_code: makePortalErpCode(new Date()),
    sort_order: (last?.sort_order ?? 0) + SORT_STEP,
    is_active: false,
  });
  if (error) {
    console.error("createCategory insert:", error);
    return { ok: false, code: "DB_ERROR", values };
  }

  // No redirect: the list beside the form redraws with the new (hidden) row in
  // it and the form stays open, which is how a staff member adds four
  // categories in a row. React resets the fields to the empty defaults this
  // success returns.
  revalidateCategoryPaths();
  return { ok: true, code: null, values: null };
}

/**
 * Save a category's editable words: its name in either language, and the
 * 一级分类 it is filed under.
 *
 * The parent travels as TEXT in one locale, because that is what the form's
 * datalist field holds — `resolveParentLabel` turns it back into a jsonb pair,
 * reusing the stored pair whenever the text matches an existing parent in
 * either language (the whole point: a lookalike object would split the group
 * in the OTHER language). That match needs the labels already in the table, so
 * this action reads them first — the same bounded read every category read in
 * this file makes.
 */
export async function renameCategory(formData: FormData): Promise<void> {
  await assertStaff();
  const locale = safeLocale(formData.get("locale"));
  const view = viewState(formData);

  const id = parseCategoryId(formData.get("id"));
  if (id === null) return finish(locale, "BAD_INPUT", view);

  const checked = validateCategoryName(
    formData.get("name_zh"),
    formData.get("name_es"),
  );
  if (!checked.ok) return finish(locale, checked.code, view);

  // Same crafted-POST rule as `createCategory`'s `raw`: a file part must not
  // become the string "[object File]" and land in the column.
  const parentEntry = formData.get("parent");
  const parentText = typeof parentEntry === "string" ? parentEntry.trim() : "";
  // The parent is a name like any other, so it lives under the same length
  // roof — the rail heading it becomes is drawn in the same 92px gutter.
  if (parentText.length > MAX_CATEGORY_NAME_LENGTH) {
    return finish(locale, "BAD_INPUT", view);
  }

  const supabase = await createServerSupabase();
  const { data: parentRows, error: parentError } = await supabase
    .from("categories")
    .select("parent_label")
    .not("parent_label", "is", null)
    .limit(CATEGORY_LIMIT);
  if (parentError) {
    console.error("renameCategory parent read:", parentError);
    return finish(locale, "DB_ERROR", view);
  }
  const parent = resolveParentLabel(
    parentText,
    (parentRows ?? []).map((row) => row.parent_label),
  );

  // `select("id")` is how a write that matched NOTHING is told apart from one
  // that worked: RLS refuses the statement outright for a non-staff caller, but
  // an id that no longer exists updates zero rows and reports no error at all.
  const { data, error } = await supabase
    .from("categories")
    .update({ name: checked.name, parent_label: parent })
    .eq("id", id)
    .select("id");
  if (error) {
    console.error("renameCategory:", error);
    return finish(locale, "DB_ERROR", view);
  }
  if ((data ?? []).length === 0) return finish(locale, "NOT_FOUND", view);

  return finish(locale, "ok", view);
}

/**
 * Set who may see a category: everyone, or an explicit list of companies.
 *
 * One press writes both halves — the `visibility` word on the row, and the
 * whole allowlist, replaced with whatever the checkboxes said. The allowlist
 * is written even when the word is 'all': the boxes were on the form the staff
 * member pressed 保存 on, so keeping rows the form no longer shows would make
 * the NEXT switch to 'selected' resurrect a list nobody could see.
 *
 * Replace is delete-then-insert, not a transaction — PostgREST speaks one
 * statement at a time. A failure between the two leaves the category with
 * FEWER grants than intended, which fails in the safe direction (a customer
 * loses sight of a shelf, none gains one), the banner says DB_ERROR, and the
 * next successful save rewrites the whole list anyway.
 */
export async function setCategoryVisibility(formData: FormData): Promise<void> {
  await assertStaff();
  const locale = safeLocale(formData.get("locale"));
  const view = viewState(formData);

  const id = parseCategoryId(formData.get("id"));
  const visibility = parseVisibility(formData.get("visibility"));
  if (id === null || visibility === null) {
    return finish(locale, "BAD_INPUT", view);
  }

  // Company ids off the checkboxes. Shape-checked here (uuid or refused) so a
  // crafted POST answers BAD_INPUT instead of a Postgres cast error dressed as
  // DB_ERROR; the FK and RLS behind it are the real gate.
  const companyIds: string[] = [];
  for (const value of formData.getAll("company")) {
    if (
      typeof value !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        value,
      )
    ) {
      return finish(locale, "BAD_INPUT", view);
    }
    companyIds.push(value);
  }

  const supabase = await createServerSupabase();
  const { data, error } = await supabase
    .from("categories")
    .update({ visibility })
    .eq("id", id)
    .select("id");
  if (error) {
    console.error("setCategoryVisibility:", error);
    return finish(locale, "DB_ERROR", view);
  }
  if ((data ?? []).length === 0) return finish(locale, "NOT_FOUND", view);

  const { error: clearError } = await supabase
    .from("category_companies")
    .delete()
    .eq("category_id", id);
  if (clearError) {
    console.error("setCategoryVisibility clear:", clearError);
    return finish(locale, "DB_ERROR", view);
  }

  if (companyIds.length > 0) {
    const { error: grantError } = await supabase
      .from("category_companies")
      .insert(
        companyIds.map((companyId) => ({
          category_id: id,
          company_id: companyId,
        })),
      );
    if (grantError) {
      console.error("setCategoryVisibility grants:", grantError);
      return finish(locale, "DB_ERROR", view);
    }
  }

  return finish(locale, "ok", view);
}

/**
 * Show or hide a category. This app's retirement path, and there is no other.
 *
 * There is no delete: `products.category_id` references this row with no cascade
 * and no null-out (`supabase/migrations/0002_catalog.sql:16`), so a category
 * with anything filed under it could not be removed anyway, and a category that
 * has ever been ordered from is part of the record. Hidden means the rail entry
 * is gone and the products stay reachable under 全部 — the copy on the button's
 * card says exactly that.
 */
export async function setCategoryActive(formData: FormData): Promise<void> {
  await assertStaff();
  const locale = safeLocale(formData.get("locale"));
  const view = viewState(formData);

  const id = parseCategoryId(formData.get("id"));
  const active = parseActiveFlag(formData.get("active"));
  if (id === null || active === null) {
    return finish(locale, "BAD_INPUT", view);
  }

  const supabase = await createServerSupabase();
  const { data, error } = await supabase
    .from("categories")
    .update({ is_active: active })
    .eq("id", id)
    .select("id");
  if (error) {
    console.error("setCategoryActive:", error);
    return finish(locale, "DB_ERROR", view);
  }
  if ((data ?? []).length === 0) return finish(locale, "NOT_FOUND", view);

  return finish(locale, "ok", view);
}

/**
 * Move one category up or down the rail.
 *
 * Reads the WHOLE list first because the move is a swap in an order that is only
 * partly written down: most of the 61 seeded rows share a `sort_order`, so which
 * row is "the one above" is a question about names as well as numbers, and only
 * the full list can answer it. `moveCategory` in `lib/categories.ts` does that
 * arithmetic and hands back the numbers the whole list should carry;
 * `is_active` is not read because hidden rows sit in the SAME sequence — they
 * simply are not drawn on the customer's rail.
 *
 * **Written one statement per changed row, on purpose.** `upsert` cannot be used
 * here: `categories.id` is `generated always as identity`
 * (`supabase/migrations/0002_catalog.sql:3`), which Postgres refuses to accept a
 * value for, and the generated types say so too (`id?: never` on Insert/Update)
 * — an upsert would have to send whole rows, name and erp_code included, to
 * change one integer. The loop is bounded by the number of categories, 61 today;
 * the FIRST move on a list that has never been sequenced rewrites nearly all of
 * them and every move after that writes exactly two, because `resequence` is
 * idempotent.
 *
 * **Written TAIL FIRST, and that is the whole reason for the `.reverse()`.**
 * `sort_order` carries no unique index, so no intermediate state is illegal and
 * the next successful move heals whatever this one left — but "not illegal" is
 * not "harmless", and the direction the loop runs decides which. Consider the
 * first-ever move on the freepos seed, where dozens of rows still sit on 0 and
 * the NAME is what orders them: head-first, a failure three rows in leaves rows
 * 1-3 carrying 10/20/30 and every UNWRITTEN row still on 0 — and 0 sorts AHEAD
 * of 10, so the rail comes back with the untouched tail hoisted to the top. The
 * whole customer-facing order rotates because one UPDATE failed.
 *
 * Tail-first inverts exactly that. The rows that get written are the ones at the
 * BOTTOM, and the un-written head keeps its 0 — which sorts to the FRONT, broken
 * by name, which is the order those rows were already in. Work it through on the
 * seed above and the partial states are only ever two: while the un-written head
 * still contains both of the swapped rows, their names put them back and the
 * list reads exactly as it did before the press; once the head is short enough
 * that it no longer holds both, the list reads exactly as it would have if every
 * write had landed. There is no third order. In steady state (every row already
 * numbered, so `changed` is just the two rows that swapped) a failure after the
 * first write leaves the pair sharing one number, the comparator settles that by
 * name, and the move simply did not take.
 *
 * The DB_ERROR paths revalidate like every other, which is deliberate: a write
 * loop that stopped halfway still changed rows, and leaving the pre-press order
 * in the Router Cache would draw a list the database no longer holds. (On the
 * read failure nothing changed, and the same revalidate just redraws an
 * unchanged list.)
 *
 * **Two staff members moving at once: last write wins.** Both read the same base
 * list and both compute a FULL re-sequence of it, so their statements interleave
 * onto a coherent permutation rather than a corrupt one — every row still ends
 * up with exactly one number, and the list still reads top to bottom. In steady
 * state each mover writes only its own swapped pair, so two moves on disjoint
 * pairs both land; only where the writes overlap (the same pair, or the
 * un-numbered seed above, where `changed` is the whole list) do the later writes
 * override the earlier, and a move can silently fail to take, with no conflict
 * shown to either mover. That is the same trade `createCategory` documents for
 * its read-then-write `sort_order`, and it is accepted for the same reason —
 * this is a two-person back office reordering a 61-row rail by hand, not a
 * contended queue.
 */
export async function moveCategoryAction(formData: FormData): Promise<void> {
  await assertStaff();
  const locale = safeLocale(formData.get("locale"));
  const view = viewState(formData);

  const id = parseCategoryId(formData.get("id"));
  const dir = parseMoveDirection(formData.get("dir"));
  if (id === null || dir === null) return finish(locale, "BAD_INPUT", view);

  const supabase = await createServerSupabase();
  const { data: rows, error } = await supabase
    .from("categories")
    .select("id, name, sort_order")
    // The whole table, which is 61 rows and has been since the freepos seed.
    // `CATEGORY_LIMIT` is the SAME bound the page draws under, imported rather
    // than repeated, and `.order("id")` is what makes sharing it mean anything:
    // two unordered `limit` reads may return two different subsets of a table
    // past the bound, and a row the page drew but this read missed would answer
    // its own ↑ with NOT_FOUND. Not the display order — `moveCategory` sorts.
    .order("id")
    .limit(CATEGORY_LIMIT);
  if (error) {
    console.error("moveCategoryAction read:", error);
    return finish(locale, "DB_ERROR", view);
  }

  const categories = rows ?? [];
  // The two null cases of `moveCategory`, told apart here where the list is
  // known: a row at the end it was pushed towards is EDGE (the buttons are
  // disabled there, so this is a stale page), an id that is not in the list at
  // all is NOT_FOUND.
  if (!categories.some((row) => row.id === id)) {
    return finish(locale, "NOT_FOUND", view);
  }
  const next = moveCategory(categories, id, dir, locale);
  if (next === null) return finish(locale, "EDGE", view);

  const before = new Map(categories.map((row) => [row.id, row.sort_order]));
  const changed = next.filter((row) => before.get(row.id) !== row.sort_order);

  // Bottom of the list upwards — see the note above. `changed` comes back in
  // rail order, so this copy is reversed rather than iterated backwards by
  // index, which keeps the loop body reading as "for each row".
  for (const row of [...changed].reverse()) {
    const result = await supabase
      .from("categories")
      .update({ sort_order: row.sort_order })
      .eq("id", row.id);
    if (result.error) {
      console.error("moveCategoryAction write:", result.error);
      return finish(locale, "DB_ERROR", view);
    }
  }

  return finish(locale, "ok", view);
}
