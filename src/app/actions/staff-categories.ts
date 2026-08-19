"use server";

import { hasLocale } from "next-intl";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { routing } from "@/i18n/routing";
import { getSessionUser } from "@/lib/auth/session";
import type { CategoryError, CategoryFormState } from "@/lib/categories";
import {
  makePortalErpCode,
  moveCategory,
  parseActiveFlag,
  parseCategoryId,
  parseMoveDirection,
  SORT_STEP,
  validateCategoryName,
} from "@/lib/categories";
import { createServerSupabase } from "@/lib/supabase/server";

/**
 * 分类管理's four writes — and the only writes in this app that a staff member
 * performs with their OWN credentials.
 *
 * **Why there is no RPC here, and no service-role client.** `public.categories`
 * is the one table the security hardening left open to an authenticated staff
 * session: the three write policies gate on `private.is_staff()`
 * (`supabase/migrations/20260815101406_security_order_integrity.sql:156-164`),
 * the table grant carries `insert, update, delete … to authenticated` (:688) and
 * the identity sequence is usable by the same role (:719). So the DATABASE is
 * the gate on every statement below, under the caller's own JWT, and this
 * feature needed neither a migration nor a new SECURITY DEFINER function — which
 * is why the accepted security-advisor baseline in CLAUDE.md is unchanged by it.
 *
 * `assertStaff` below is not that gate. It is the early, kinder half: a Server
 * Action is its own POST endpoint, reachable by anyone who knows the action id
 * without ever rendering the page, and a caller who gets that far should be
 * stopped here rather than one round trip later. If it were ever removed, RLS
 * would still refuse every statement in this file.
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
 * Server-action staff gate: verifies an active staff_users row; throws otherwise.
 *
 * The third byte-identical copy of this helper (`staff-products.ts:27`,
 * `staff-orders.ts:35`). It is copied rather than shared ON PURPOSE for now:
 * Plan 14's Task A3 touches `staff-products.ts` and converges all three into one
 * exported helper, and converging them from HERE would edit two files this task
 * has no other business in. It throws rather than redirects, which is the Server
 * Action idiom in this app — there is no page to send anybody back to.
 */
async function assertStaff() {
  const user = await getSessionUser();
  if (!user) throw new Error("UNAUTHENTICATED");

  const supabase = await createServerSupabase();
  const { data: staffUser, error } = await supabase
    .from("staff_users")
    .select("id, is_active")
    .eq("id", user.id)
    .maybeSingle();
  if (error) console.error("assertStaff:", error);
  if (!staffUser?.is_active) throw new Error("NOT_STAFF");
}

/**
 * Every path the rail's order or wording can reach, cleared at once.
 *
 * Both pages are `force-dynamic`, so the SERVER re-reads on the next request
 * regardless; what this clears is the client-side Router Cache, which is the
 * copy that would otherwise let somebody navigate BACK to a catalogue rendered
 * from the old order. Both locales, because the staff member's language is not
 * the restaurant's — a rename in the zh back office has to reach the es rail.
 */
function revalidateCategoryPaths() {
  for (const locale of routing.locales) {
    revalidatePath(`/${locale}/staff/categorias`);
    revalidatePath(`/${locale}/catalogo`);
  }
}

/**
 * Where a finished (or refused) row action lands: back on the page it came
 * from, carrying the one word it needs to draw its banner — the `?result=<CODE>`
 * convention `staff-users.ts`, `staff-orders.ts` and `staff-settings.ts` share —
 * and the category that was selected, so the detail pane does not jump.
 *
 * Returns `never` because `redirect()` works by THROWING NEXT_REDIRECT, which is
 * why no call to it may sit inside a catch-all try.
 */
function finish(
  locale: string,
  result: "ok" | CategoryError,
  selected: string,
): never {
  revalidateCategoryPaths();
  const params = new URLSearchParams({ result });
  if (selected) params.set("cat", selected);
  redirect(`/${locale}/staff/categorias?${params}`);
}

/** The `?cat=` the form was rendered under, echoed back through the redirect. */
function selectedFrom(formData: FormData): string {
  const id = parseCategoryId(formData.get("cat"));
  return id === null ? "" : String(id);
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

  // Kept exactly as typed, so a rejected create can redraw the fields it was
  // sent rather than blanking both of them.
  const zhRaw = String(formData.get("name_zh") ?? "");
  const esRaw = String(formData.get("name_es") ?? "");
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

/** Rename a category in either language, or in both. */
export async function renameCategory(formData: FormData): Promise<void> {
  await assertStaff();
  const locale = safeLocale(formData.get("locale"));
  const selected = selectedFrom(formData);

  const id = parseCategoryId(formData.get("id"));
  if (id === null) return finish(locale, "BAD_INPUT", selected);

  const checked = validateCategoryName(
    formData.get("name_zh"),
    formData.get("name_es"),
  );
  if (!checked.ok) return finish(locale, checked.code, selected);

  const supabase = await createServerSupabase();
  // `select("id")` is how a write that matched NOTHING is told apart from one
  // that worked: RLS refuses the statement outright for a non-staff caller, but
  // an id that no longer exists updates zero rows and reports no error at all.
  const { data, error } = await supabase
    .from("categories")
    .update({ name: checked.name })
    .eq("id", id)
    .select("id");
  if (error) {
    console.error("renameCategory:", error);
    return finish(locale, "DB_ERROR", selected);
  }
  if ((data ?? []).length === 0) return finish(locale, "NOT_FOUND", selected);

  return finish(locale, "ok", selected);
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
  const selected = selectedFrom(formData);

  const id = parseCategoryId(formData.get("id"));
  const active = parseActiveFlag(formData.get("active"));
  if (id === null || active === null) {
    return finish(locale, "BAD_INPUT", selected);
  }

  const supabase = await createServerSupabase();
  const { data, error } = await supabase
    .from("categories")
    .update({ is_active: active })
    .eq("id", id)
    .select("id");
  if (error) {
    console.error("setCategoryActive:", error);
    return finish(locale, "DB_ERROR", selected);
  }
  if ((data ?? []).length === 0) return finish(locale, "NOT_FOUND", selected);

  return finish(locale, "ok", selected);
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
 * idempotent. A failure halfway leaves a shorter but still strictly increasing
 * sequence — `sort_order` carries no unique index, so no intermediate state is
 * illegal — and the next move re-sequences from whatever is there.
 */
export async function moveCategoryAction(formData: FormData): Promise<void> {
  await assertStaff();
  const locale = safeLocale(formData.get("locale"));
  const selected = selectedFrom(formData);

  const id = parseCategoryId(formData.get("id"));
  const dir = parseMoveDirection(formData.get("dir"));
  if (id === null || dir === null) return finish(locale, "BAD_INPUT", selected);

  const supabase = await createServerSupabase();
  const { data: rows, error } = await supabase
    .from("categories")
    .select("id, name, sort_order")
    // The whole table, which is 61 rows and has been since the freepos seed.
    // The bound is here so a runaway list cannot silently re-sequence a page of
    // itself; it is far above anything a hand-managed rail can reach.
    .limit(500);
  if (error) {
    console.error("moveCategoryAction read:", error);
    return finish(locale, "DB_ERROR", selected);
  }

  const categories = rows ?? [];
  // The two null cases of `moveCategory`, told apart here where the list is
  // known: a row at the end it was pushed towards is EDGE (the buttons are
  // disabled there, so this is a stale page), an id that is not in the list at
  // all is NOT_FOUND.
  if (!categories.some((row) => row.id === id)) {
    return finish(locale, "NOT_FOUND", selected);
  }
  const next = moveCategory(categories, id, dir, locale);
  if (next === null) return finish(locale, "EDGE", selected);

  const before = new Map(categories.map((row) => [row.id, row.sort_order]));
  const changed = next.filter((row) => before.get(row.id) !== row.sort_order);

  for (const row of changed) {
    const result = await supabase
      .from("categories")
      .update({ sort_order: row.sort_order })
      .eq("id", row.id);
    if (result.error) {
      console.error("moveCategoryAction write:", result.error);
      return finish(locale, "DB_ERROR", selected);
    }
  }

  return finish(locale, "ok", selected);
}
