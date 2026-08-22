"use server";

import { hasLocale } from "next-intl";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { routing } from "@/i18n/routing";
import { assertStaff } from "@/lib/auth/assert-staff";
import {
  CATALOG_IMAGE_BUCKET,
  validateCatalogImage,
} from "@/lib/catalog-image";
import type { CategoryError, CategoryFormState } from "@/lib/categories";
import {
  CATEGORY_LIMIT,
  makePortalErpCode,
  MAX_CATEGORY_NAME_LENGTH,
  moveCategoryInTree,
  parseActiveFlag,
  parseCategoryId,
  parseCategoryOrder,
  parseMoveDirection,
  parseVisibility,
  resolveParentLabel,
  SORT_STEP,
  validateCategoryName,
} from "@/lib/categories";
import { createAdminClient } from "@/lib/supabase/admin";
import { createServerSupabase } from "@/lib/supabase/server";

/**
 * Category metadata writes use the caller's session and the staff-only RLS
 * policy. Ordering is intentionally narrower: authenticated cannot update
 * `sort_order` directly, so both drag saves and the progressive ↑/↓ fallback
 * call one SECURITY DEFINER RPC that rechecks staff, locks the collection and
 * validates the complete tree. Image bytes use the admin Storage client only
 * after `assertStaff`; the category URL itself is still written through RLS.
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
 * 分类 FILTER is a `<select>` of every category, so a rename changes the option
 * labels and a hide/show moves the （已隐藏） marker on one of them. (The per-ROW
 * category select that used to be the reason is gone — 2026-08-22 moved filing
 * into the product editor — but the filter above the table still has to be
 * redrawn.) Nothing there is invalidated by a MOVE, but the writes share one
 * revalidation for the same reason they share one file — a caller that had to
 * pick would eventually pick wrong.
 */
function revalidateCategoryPaths() {
  for (const locale of routing.locales) {
    revalidatePath(`/${locale}/staff/categorias`);
    revalidatePath(`/${locale}/staff/productos`);
    revalidatePath(`/${locale}/categorias`);
    revalidatePath(`/${locale}/catalogo`);
    // Search filters by the same visibility the catalogue does (owner,
    // 2026-08-20), so a grant change has to clear its cached copy too.
    revalidatePath(`/${locale}/buscar`);
  }
}

/** A stale/forged full order is actionable; an infrastructure failure is not. */
function reorderError(error: { message: string }): CategoryError {
  return error.message.includes("BAD_ORDER") || error.message.includes("BAD_TREE")
    ? "ORDER_STALE"
    : "DB_ERROR";
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
  /**
   * Which 一级 group the tree had expanded — the group's label, the page's
   * own `-` sentinel for "explicitly none", or "" when the form carried
   * nothing. Without it, pressing ↑ inside an expanded group would collapse
   * the tree on the redirect and the second press would have nothing to
   * press.
   */
  open: string;
}

function viewState(formData: FormData): ViewState {
  const id = parseCategoryId(formData.get("cat"));
  const openEntry = formData.get("open");
  const open = typeof openEntry === "string" ? openEntry : "";
  return {
    cat: id === null ? "" : String(id),
    // The literal "1" and nothing else — the one value `pageHref` writes and
    // the page reads. Anything else simply closes the card, which is the safe
    // reading of a field a crafted POST controls.
    creating: formData.get("new") === "1",
    // Only ever COMPARED against group labels (never rendered raw), so the
    // one guard it needs is a length roof: a label past the name cap matches
    // nothing anyway.
    open: open.length > MAX_CATEGORY_NAME_LENGTH ? "" : open,
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
  if (view.open) params.set("open", view.open);
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
 * Replace, recommend, or clear the artwork used by the customer category grid.
 *
 * A recommendation URL never comes from a hidden field. The action looks up a
 * product that is still filed under this category and copies its stored URL;
 * otherwise a forged POST could turn the public category tile into an arbitrary
 * remote-image request. Uploads share the exact validator and public bucket used
 * by `updateProduct`.
 */
export async function updateCategoryImage(formData: FormData): Promise<void> {
  await assertStaff();
  const locale = safeLocale(formData.get("locale"));
  const view = viewState(formData);
  const id = parseCategoryId(formData.get("id"));
  const rawMode = formData.get("mode");
  const mode =
    rawMode === "upload" || rawMode === "recommended" || rawMode === "clear"
      ? rawMode
      : null;
  if (id === null || mode === null) return finish(locale, "BAD_INPUT", view);

  const supabase = await createServerSupabase();
  const category = await supabase
    .from("categories")
    .select("id")
    .eq("id", id)
    .maybeSingle();
  if (category.error) {
    console.error("updateCategoryImage category lookup:", category.error);
    return finish(locale, "DB_ERROR", view);
  }
  if (!category.data) return finish(locale, "NOT_FOUND", view);

  let imageUrl: string | null = null;
  if (mode === "recommended") {
    const recommendation = await supabase
      .from("products")
      .select("image_url")
      .eq("category_id", id)
      .not("image_url", "is", null)
      .order("codart")
      .limit(1)
      .maybeSingle();
    if (recommendation.error) {
      console.error("updateCategoryImage recommendation:", recommendation.error);
      return finish(locale, "DB_ERROR", view);
    }
    imageUrl = recommendation.data?.image_url ?? null;
    if (!imageUrl) return finish(locale, "NO_IMAGE", view);
  }

  if (mode === "upload") {
    const file = formData.get("image");
    if (!(file instanceof File) || file.size === 0) {
      return finish(locale, "BAD_INPUT", view);
    }
    const checkedImage = validateCatalogImage(file);
    if (!checkedImage.ok) {
      return finish(locale, checkedImage.code, view);
    }

    const path = `categories/${id}-${Date.now()}.${checkedImage.extension}`;
    const admin = createAdminClient();
    const upload = await admin.storage
      .from(CATALOG_IMAGE_BUCKET)
      .upload(path, file, { contentType: file.type, upsert: false });
    if (upload.error) {
      console.error("updateCategoryImage upload:", upload.error);
      return finish(locale, "UPLOAD_FAILED", view);
    }
    imageUrl = admin.storage
      .from(CATALOG_IMAGE_BUCKET)
      .getPublicUrl(path).data.publicUrl;
  }

  const { data, error } = await supabase
    .from("categories")
    .update({ image_url: imageUrl })
    .eq("id", id)
    .select("id");
  if (error) {
    console.error("updateCategoryImage update:", error);
    return finish(locale, "DB_ERROR", view);
  }
  if ((data ?? []).length === 0) return finish(locale, "NOT_FOUND", view);
  return finish(locale, "ok", view);
}

/** Persist the drag editor's complete flattened tree in one database statement. */
export async function reorderCategoriesAction(
  formData: FormData,
): Promise<void> {
  await assertStaff();
  const locale = safeLocale(formData.get("locale"));
  const view = viewState(formData);
  const order = parseCategoryOrder(formData.get("order"));
  if (order === null) return finish(locale, "BAD_INPUT", view);

  const supabase = await createServerSupabase();
  const { data, error } = await supabase.rpc("staff_reorder_categories", {
    p_order: order,
    p_locale: locale,
  });
  if (error) {
    console.error("reorderCategoriesAction:", error);
    return finish(locale, reorderError(error), view);
  }
  if (data !== true) return finish(locale, "DB_ERROR", view);
  return finish(locale, "ok", view);
}

/**
 * Progressive enhancement for the sorter's ↑/↓ buttons. With JavaScript the
 * component applies the step locally and the explicit Save posts once; without
 * JavaScript this action derives the same full flattened tree server-side and
 * persists it through the atomic reorder RPC.
 */
export async function moveCategoryAction(formData: FormData): Promise<void> {
  await assertStaff();
  const locale = safeLocale(formData.get("locale"));
  const view = viewState(formData);

  const dir = parseMoveDirection(formData.get("dir"));
  // `group` wins when both arrive (no page form sends both): a group label is
  // TEXT, checked only for being a plausible name — `moveCategoryInTree`
  // answers an unknown label with NOT_FOUND, which is also what a crafted
  // value deserves.
  const groupEntry = formData.get("group");
  const group =
    typeof groupEntry === "string" &&
    groupEntry !== "" &&
    groupEntry.length <= MAX_CATEGORY_NAME_LENGTH
      ? groupEntry
      : null;
  const id = group === null ? parseCategoryId(formData.get("id")) : null;
  const target = group !== null ? { group } : id !== null ? { id } : null;
  if (target === null || dir === null) {
    return finish(locale, "BAD_INPUT", view);
  }

  const supabase = await createServerSupabase();
  const { data: rows, error } = await supabase
    .from("categories")
    .select("id, name, parent_label, sort_order")
    // The whole table, which is 61 rows and has been since the freepos seed.
    // `CATEGORY_LIMIT` is the SAME bound the page draws under, imported rather
    // than repeated, and `.order("id")` is what makes sharing it mean anything:
    // two unordered `limit` reads may return two different subsets of a table
    // past the bound, and a row the page drew but this read missed would answer
    // its own ↑ with NOT_FOUND. Not the display order — the tree derivation
    // inside `moveCategoryInTree` sorts.
    .order("id")
    .limit(CATEGORY_LIMIT);
  if (error) {
    console.error("moveCategoryAction read:", error);
    return finish(locale, "DB_ERROR", view);
  }

  const categories = rows ?? [];
  const moved = moveCategoryInTree(categories, target, dir, locale);
  // EDGE is a stale page (the buttons are disabled at the ends); NOT_FOUND is
  // a row or group the list no longer holds. Both are refresh-and-look codes.
  if (!moved.ok) return finish(locale, moved.code, view);

  const result = await supabase.rpc("staff_reorder_categories", {
    p_order: moved.sorts.map((row) => row.id),
    p_locale: locale,
  });
  if (result.error) {
    console.error("moveCategoryAction write:", result.error);
    return finish(locale, reorderError(result.error), view);
  }
  if (result.data !== true) return finish(locale, "DB_ERROR", view);

  return finish(locale, "ok", view);
}
