"use server";

import { hasLocale } from "next-intl";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { routing } from "@/i18n/routing";
import { assertStaff } from "@/lib/auth/assert-staff";
import { parseCategoryId } from "@/lib/categories";
import { formText } from "@/lib/form-text";
import { isUuid } from "@/lib/orders";
import type { ProductEditResult } from "@/lib/product-edit";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/database.types";

/** The generated shape of a `products` patch — see `updateProduct`. */
type ProductUpdate = Database["public"]["Tables"]["products"]["Update"];

/** The bilingual name jsonb, as an alias so it stays assignable to `Json`. */
type ProductName = { zh?: string; es?: string };

/**
 * The local name for the shared `formText` (`lib/form-text.ts`): a form field as
 * trimmed text, or "" for anything that is not a string. This file read every
 * field through `text(...)` before that helper existed.
 */
const text = formText;

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
 * variants the catalogue lists at all.
 *
 * FOUR pages, both locales: `/staff/productos`, `/catalogo`, `/buscar` and
 * `/carrito`. The cart was the gap in the first version of this list, and the
 * comment claimed the list was complete while it was missing — the cart page
 * reads `is_weighed` and `is_orderable` out of `products_priced`
 * (`carrito/page.tsx:119-129`) and renders BOTH: the unavailable banner, the
 * dead submit button, the `opacity-45` line and the fractional quantity step all
 * come off those two columns. `staff-settings.ts` already fans to `/carrito` for
 * the same reason.
 *
 * **What this actually buys, and what it does not.**
 * `revalidatePath` called from a Server Function purges the Router Cache of the
 * browser that INVOKED it — immediately if that client is looking at the path,
 * on the next navigation otherwise
 * (`node_modules/next/dist/docs/01-app/03-api-reference/04-functions/revalidatePath.md`).
 * A staff POST cannot reach a restaurant's browser, and all four routes are
 * `force-dynamic`, so there is no server-side Full Route Cache entry to purge
 * either. What the fan-out clears is therefore the ACTING staff member's own
 * stale copies — their `/staff/productos` in both languages, and the customer
 * pages if they navigate to one after flipping a flag — plus the future-proofing
 * for any of these routes ever dropping `force-dynamic`.
 *
 * A customer-visible freshness guarantee does not exist today and this helper
 * cannot create one; it would take tagged reads and `revalidateTag`, so that a
 * customer's own next request revalidates against a tag this write bumped.
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
    revalidatePath(`/${locale}/carrito`);
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
 *
 * Not exact, deliberately: composing the product base above also re-clears
 * `/buscar`, which an assignment cannot change — the search results render a
 * product's name, code and price and never its category. One over-cleared path
 * on one action, in exchange for a helper that is provably "the product list
 * plus one"; a documented over-clear beats an implied exactness.
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
  /*
   * The id gets the same narrowing `setProductCategory`'s category field gets
   * from `parseCategoryId` — proved to be the shape of its column before it is
   * allowed near one.
   *
   * All four actions in this file used to test `product_id` for emptiness and
   * hand whatever else arrived straight to PostgREST, and a crafted or stale
   * POST had two ways past that. A malformed id reached Postgres as a uuid cast
   * error (22P02), which is a log line about the database rather than about the
   * request. And a WELL-FORMED id naming no product was the worse of the two:
   * `.eq("id", …)` matched nothing, PostgREST reported no error, and the action
   * revalidated and returned as though it had written something. Silent success
   * on a write that did not happen is the failure this check exists to make
   * impossible — the shape is now refused here, by name, in the log.
   *
   * `isUuid` is `lib/orders.ts`'s, the house's — the same predicate `checkout.ts`
   * proves `p_client_token` with before `create_order` sees it. `text()` above
   * has already trimmed, so it is a string by the time it gets here.
   */
  if (!isUuid(productId)) {
    console.error("setProductAvailability: bad product_id");
    return;
  }

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
  if (!isUuid(productId)) {
    console.error("setProductCategory: bad product_id");
    return;
  }

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
  if (!isUuid(productId)) {
    console.error("setProductWeighed: bad product_id");
    return;
  }

  const admin = createAdminClient();
  const { error } = await admin
    .from("products")
    .update({ is_weighed: weighed })
    .eq("id", productId);
  if (error) console.error("setProductWeighed:", error);

  revalidateProductPaths();
}

/*
 * `setCurrentVariant` lived here until 2026-08-21. Variant groups are dissolved
 * — every product is its own group of one (migration
 * `20260821180000_dissolve_variant_groups.sql`) — so promoting one member over
 * the others is not a thing a staff member can do or would want to: F-008 and
 * F-008A are two products, both stocked, both orderable. The column survives as
 * an always-true flag behind `is_orderable`; nothing writes it any more.
 */

/** The three formats the photo pipeline already produces, and nothing else. */
const IMAGE_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

/** 5 MB. A catalogue photo is ~40 KB; this is a guard, not a budget. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** The public bucket the 2,956 imported photos already live in. */
const IMAGE_BUCKET = "product-images";

/**
 * Everything about one product that a staff member may change, in one save.
 *
 * **Why this exists at all** (owner, 2026-08-21): the catalogue was imported
 * from freepos and then maintained by three toggle buttons. A wrong name, a
 * missing photo, a typo'd SKU had no repair path short of SQL — and the row's
 * button cluster had grown to four controls that between them still could not
 * fix any of that. This is the repair path; the row now carries one 编辑 link.
 *
 * **The SKU is editable, and it is the sharp edge.** `codart` is the ERP join
 * key: the nightly price-sync matches on it, and the bridge injects order lines
 * with it. Renaming it to a code Wingest does not have leaves the product
 * priceless and its orders rejected at injection — which is why the form warns
 * in words, why the uniqueness clash comes back as its own message rather than
 * a 23505, and why `base_sku` is rewritten alongside it (the
 * `products_codart_composition` check demands codart = base_sku ||
 * variant_suffix, and after the variant dissolution the suffix is always "").
 *
 * The photo is optional on every save: an empty file part means "keep the
 * current one", which is what a browser sends when the staff member changed a
 * name and touched nothing else.
 */
export async function updateProduct(formData: FormData): Promise<void> {
  await assertStaff();

  const productId = text(formData.get("product_id"));
  const locale = safeLocale(formData.get("locale"));
  if (!isUuid(productId)) {
    console.error("updateProduct: bad product_id");
    return finishEdit(locale, productId, "BAD_INPUT");
  }

  const nameZh = text(formData.get("name_zh"));
  const nameEs = text(formData.get("name_es"));
  if (!nameZh && !nameEs) return finishEdit(locale, productId, "NAME_REQUIRED");

  const codart = text(formData.get("codart"));
  if (!codart || codart.length > 30) {
    return finishEdit(locale, productId, "CODART_REQUIRED");
  }

  const unit = text(formData.get("unit")).slice(0, 20);
  const perCaseRaw = text(formData.get("units_per_case"));
  const unitsPerCase = /^\d{1,6}$/.test(perCaseRaw) ? Number(perCaseRaw) : 1;
  if (unitsPerCase < 1) return finishEdit(locale, productId, "BAD_INPUT");

  const field = formData.get("category");
  const wantsNone = typeof field === "string" && field.trim() === "";
  const categoryId = wantsNone ? null : parseCategoryId(field);
  if (!wantsNone && categoryId === null) {
    return finishEdit(locale, productId, "BAD_INPUT");
  }

  const admin = createAdminClient();

  // The clash is READ rather than caught: `products_codart_key` would answer a
  // taken code as a 23505 the staff member never sees, and this page's banner
  // speaks result codes, not Postgres ones.
  const clash = await admin
    .from("products")
    .select("id")
    .eq("codart", codart)
    .neq("id", productId)
    .maybeSingle();
  if (clash.error) {
    console.error("updateProduct codart lookup:", clash.error);
    return finishEdit(locale, productId, "DB_ERROR");
  }
  if (clash.data) return finishEdit(locale, productId, "CODART_TAKEN");

  // The photo, when one was actually chosen. A path per upload rather than one
  // per product: overwriting `<codart>.jpg` in a PUBLIC bucket leaves the CDN
  // and every open tab holding the old bytes, and the new photo appears to have
  // silently failed. Nothing is deleted here — the previous object stays
  // reachable for anything still pointing at it.
  let imageUrl: string | null = null;
  const file = formData.get("image");
  if (file instanceof File && file.size > 0) {
    const ext = IMAGE_TYPES[file.type];
    if (!ext) return finishEdit(locale, productId, "IMAGE_TYPE");
    if (file.size > MAX_IMAGE_BYTES) {
      return finishEdit(locale, productId, "IMAGE_TOO_LARGE");
    }
    const stem = codart.replace(/[^A-Za-z0-9._-]/g, "_");
    const path = `${stem}-${Date.now()}.${ext}`;
    const upload = await admin.storage
      .from(IMAGE_BUCKET)
      .upload(path, file, { contentType: file.type, upsert: false });
    if (upload.error) {
      console.error("updateProduct image upload:", upload.error);
      return finishEdit(locale, productId, "UPLOAD_FAILED");
    }
    imageUrl = admin.storage.from(IMAGE_BUCKET).getPublicUrl(path).data.publicUrl;
  }

  // Only the keys that carry words: an empty zh on a Spanish-only product must
  // not be stored as "" — `localizedName` falls back across the two, and an
  // empty string is a name that never falls back. A type ALIAS and not an
  // interface, for the reason `CategoryName` spells out in `lib/categories.ts`:
  // only an alias gets TypeScript's implicit index signature, which is what
  // makes it assignable to the generated `Json` the column takes.
  const name: ProductName = {
    ...(nameZh ? { zh: nameZh } : {}),
    ...(nameEs ? { es: nameEs } : {}),
  };
  const patch: ProductUpdate = {
    name,
    codart,
    base_sku: codart,
    variant_suffix: "",
    unit,
    units_per_case: unitsPerCase,
    category_id: categoryId,
    is_available: formData.get("available") === "1",
    is_weighed: formData.get("weighed") === "1",
  };
  if (imageUrl) patch.image_url = imageUrl;

  const { data, error } = await admin
    .from("products")
    .update(patch)
    .eq("id", productId)
    .select("id");
  if (error) {
    console.error("updateProduct:", error);
    return finishEdit(locale, productId, "DB_ERROR");
  }
  if ((data ?? []).length === 0) {
    return finishEdit(locale, productId, "NOT_FOUND");
  }

  // The filing may have moved, so this is the wider fan-out — the same one
  // `setProductCategory` uses, for the same reason.
  return finishEdit(locale, productId, "ok");
}

/** The locale arrives in a form field, so it is never trusted as a path segment. */
function safeLocale(value: FormDataEntryValue | null) {
  const candidate = String(value ?? routing.defaultLocale);
  return hasLocale(routing.locales, candidate)
    ? candidate
    : routing.defaultLocale;
}

/**
 * Back to the editor with one word for its banner.
 *
 * Back to the EDITOR and not to the list: a rejected save has to redraw beside
 * the field that caused it, and an accepted one usually precedes another edit
 * on the same product (name, then photo). The list is one link away.
 *
 * Returns `never` — `redirect()` works by throwing NEXT_REDIRECT, so no call to
 * it may sit inside a catch-all try.
 */
function finishEdit(
  locale: string,
  productId: string,
  result: ProductEditResult,
): never {
  revalidateAssignmentPaths();
  const target = isUuid(productId)
    ? `/${locale}/staff/productos/${productId}?result=${result}`
    : `/${locale}/staff/productos`;
  redirect(target);
}
