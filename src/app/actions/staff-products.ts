"use server";

import { hasLocale } from "next-intl";
import { revalidatePath } from "next/cache";
import { routing } from "@/i18n/routing";
import { getSessionUser } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";
import { createServerSupabase } from "@/lib/supabase/server";

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
 * The page guard does not cover this. A Server Action is its own POST endpoint,
 * reachable by anyone who knows the action id without ever rendering the page,
 * and the writes below run on the service-role client, which has no RLS left to
 * fall back on. So this fails CLOSED — a throw, not the silent return the
 * favorites action can afford.
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

/** Pause or re-enable a product for ordering (`is_orderable` is generated from it). */
export async function setProductAvailability(formData: FormData) {
  await assertStaff();
  const productId = String(formData.get("product_id") ?? "");
  const locale = safeLocale(formData.get("locale"));
  const available = formData.get("available") === "1";
  if (!productId) return;

  const admin = createAdminClient();
  const { error } = await admin
    .from("products")
    .update({ is_available: available })
    .eq("id", productId);
  if (error) console.error("setProductAvailability:", error);

  revalidatePath(`/${locale}/staff/productos`);
}

/**
 * Promote a variant to current. Two-phase (demote the whole base_sku group, then
 * promote the target) because products_one_current_variant is a partial unique
 * index and cannot be deferred. The brief no-current window is acceptable for a
 * staff-only action.
 */
export async function setCurrentVariant(formData: FormData) {
  await assertStaff();
  const productId = String(formData.get("product_id") ?? "");
  const baseSku = String(formData.get("base_sku") ?? "");
  const locale = safeLocale(formData.get("locale"));
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

  revalidatePath(`/${locale}/staff/productos`);
}
