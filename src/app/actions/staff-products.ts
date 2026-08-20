"use server";

import { revalidatePath } from "next/cache";
import { routing } from "@/i18n/routing";
import { assertStaff } from "@/lib/auth/assert-staff";
import { parseCategoryId } from "@/lib/categories";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * A form field as trimmed text, or "" for anything that is not a string.
 *
 * `FormData.get` is typed `string | File` and a crafted POST can send a file
 * part, which `String()` would turn into the 13-character "[object File]" — a
 * value that passes a non-empty check and reaches the database. Same rule, and
 * the same reason, as `raw` in `staff-categories.ts` and `text` in
 * `lib/categories.ts`.
 */
function text(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Every page a product's own columns are drawn on, in BOTH languages.
 *
 * These four writes used to clear one locale's `/staff/productos` and nothing
 * else, and that was two gaps at once. The obvious one: the staff member's
 * language is not the restaurant's, so a flip made in the zh back office left
 * the es copy of the same table stale. The one that reached a CUSTOMER: every
 * column written here is drawn on the storefront too — `is_available` is the
 * 断货 badge and, through the generated `is_orderable`, whether the stepper on
 * that row does anything at all; `is_weighed` is the 称重 badge and the
 * fractional quantity step; `is_current_variant` decides which of a group's
 * variants the catalogue lists at all. So 停售 pressed here left the catalogue
 * and the search page still offering the product from the Router Cache.
 *
 * All three pages, both locales. `force-dynamic` means the SERVER re-reads
 * either way; what this clears is the client-side copy a Back button would
 * otherwise redraw from.
 *
 * Both locales is also why no action in this file reads a `locale` field any
 * more, and why the forms on `/staff/productos` no longer send one: there is
 * nothing left for it to decide. (`safeLocale` went with it — the nine copies
 * in the other action files are untouched, each in a file that still redirects
 * to, or revalidates, ONE language's path.)
 */
function revalidateProductPaths() {
  for (const locale of routing.locales) {
    revalidatePath(`/${locale}/staff/productos`);
    revalidatePath(`/${locale}/catalogo`);
    revalidatePath(`/${locale}/buscar`);
  }
}

/**
 * …and the one page a product's FILING is drawn on, for the write that changes
 * it.
 *
 * Two named helpers rather than one with a flag: `/staff/categorias` prints a
 * per-category product count and lists the products under the open category, so
 * `setProductCategory` moves a row from one of those lists to another and both
 * counts change — while the three toggles below cannot touch either (that page
 * reads neither availability nor the weighed flag nor the variant column). A
 * boolean parameter would put that distinction at the CALL SITE as
 * `revalidateProductPaths(true)`, which says nothing; the names say it.
 */
function revalidateAssignmentPaths() {
  revalidateProductPaths();
  for (const locale of routing.locales) {
    revalidatePath(`/${locale}/staff/categorias`);
  }
}

/** Pause or re-enable a product for ordering (`is_orderable` is generated from it). */
export async function setProductAvailability(formData: FormData) {
  await assertStaff();
  const productId = text(formData.get("product_id"));
  const available = formData.get("available") === "1";
  if (!productId) return;

  const admin = createAdminClient();
  const { error } = await admin
    .from("products")
    .update({ is_available: available })
    .eq("id", productId);
  if (error) console.error("setProductAvailability:", error);

  revalidateProductPaths();
}

/**
 * File a product under a category, or take it out of every category.
 *
 * The one write on `/staff/productos` that is not a flag, and the reason that
 * page has a 分类 column at all: `products.category_id` arrives from the freepos
 * import and nothing else maintains it, so a product the ERP filed nowhere — or
 * filed under a category this portal has since retired — can only be moved by
 * hand, from here.
 *
 * **Silent on failure, like its three siblings.** This page has no `?result=`
 * banner convention (the categories and orders and users pages do; this one has
 * never had one), so a refused write is a log line and a table that redraws
 * unchanged, which is what a staff member sees for a bad `is_available` write
 * today. Giving this one action a banner would mean giving the page a result
 * vocabulary for one of its four buttons.
 */
export async function setProductCategory(formData: FormData) {
  await assertStaff();
  const productId = text(formData.get("product_id"));
  if (!productId) return;

  // "" is the 未分类 option and means NULL — the only value that is not an id.
  // Everything else goes through the same parser `staff-categories.ts` reads
  // `categories.id` with (digits only, a safe integer, above zero), so a
  // crafted or stale POST cannot reach Postgres as a cast error. A missing
  // field is not "" and is refused with the rest: the select always posts one.
  const field = formData.get("category");
  const wantsNone = typeof field === "string" && field.trim() === "";
  const categoryId = wantsNone ? null : parseCategoryId(field);
  if (!wantsNone && categoryId === null) {
    console.error("setProductCategory: bad category field");
    return;
  }

  const admin = createAdminClient();
  if (categoryId !== null) {
    // The FK would refuse an id that does not exist, but it would refuse it as
    // a 409 the staff member never sees; this turns that into one log line
    // naming the id. `is_active` is deliberately NOT part of the test: a hidden
    // category still holds products (hiding takes it off the customer's rail,
    // it does not empty it — see `setCategoryActive`), so filing something
    // under one is a legitimate, and sometimes the only correct, answer.
    const { data, error } = await admin
      .from("categories")
      .select("id")
      .eq("id", categoryId)
      .maybeSingle();
    if (error) {
      console.error("setProductCategory category lookup:", error);
      return;
    }
    if (!data) {
      console.error(`setProductCategory: no category ${categoryId}`);
      return;
    }
  }

  const { error } = await admin
    .from("products")
    .update({ category_id: categoryId })
    .eq("id", productId);
  if (error) console.error("setProductCategory:", error);

  revalidateAssignmentPaths();
}

/**
 * Flag a product as sold BY WEIGHT, or take the flag off.
 *
 * One statement, like `setProductAvailability` above and unlike
 * `setCurrentVariant` below: `is_weighed` carries no unique index and no
 * generated column depends on it, so there is nothing to demote first.
 *
 * What the flag turns on is spread across three places that already read it, and
 * this action changes none of them — flipping it on is the whole feature:
 * the catalogue and cart draw the 称重 badge, the cart's quantity box switches to
 * `step=0.001` (the cookie already rounds to three decimals), and `create_order`
 * stops raising BAD_QTY_STEP for a fractional quantity on this product. The staff
 * queue's line editor reads it live for the same reason.
 *
 * The unit TEXT is deliberately left alone. It is whatever Wingest says, and the
 * badge is what carries the meaning; relabelling a product KG here would put the
 * portal and the ERP in disagreement about a column the nightly price-sync owns.
 *
 * **Turning it OFF does not stick on a KG article.** `toWingestPricePatch`
 * derives `is_weighed = true` from unit KG and never clears it, so the next
 * price-sync run will set the flag again on any product the ERP calls KG. That
 * one-way rule is what protects a hand-set flag on a product the ERP still calls
 * UNIDAD, which is the case this toggle exists for; the reverse is the ERP being
 * right about its own article.
 */
export async function setProductWeighed(formData: FormData) {
  await assertStaff();
  const productId = text(formData.get("product_id"));
  const weighed = formData.get("weighed") === "1";
  if (!productId) return;

  const admin = createAdminClient();
  const { error } = await admin
    .from("products")
    .update({ is_weighed: weighed })
    .eq("id", productId);
  if (error) console.error("setProductWeighed:", error);

  revalidateProductPaths();
}

/**
 * Promote a variant to current. Two-phase (demote the whole base_sku group, then
 * promote the target) because products_one_current_variant is a partial unique
 * index and cannot be deferred. The brief no-current window is acceptable for a
 * staff-only action.
 */
export async function setCurrentVariant(formData: FormData) {
  await assertStaff();
  const productId = text(formData.get("product_id"));
  const baseSku = text(formData.get("base_sku"));
  if (!productId || !baseSku) return;

  const admin = createAdminClient();
  const demote = await admin
    .from("products")
    .update({ is_current_variant: false })
    .eq("base_sku", baseSku);
  if (demote.error) {
    console.error("setCurrentVariant demote:", demote.error);
    return;
  }
  const promote = await admin
    .from("products")
    .update({ is_current_variant: true })
    .eq("id", productId)
    .eq("base_sku", baseSku);
  if (promote.error) console.error("setCurrentVariant promote:", promote.error);

  revalidateProductPaths();
}
