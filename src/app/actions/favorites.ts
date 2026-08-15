"use server";

import { hasLocale } from "next-intl";
import { revalidatePath } from "next/cache";
import { getSessionUser } from "@/lib/auth/session";
import { routing } from "@/i18n/routing";
import { createServerSupabase } from "@/lib/supabase/server";

/** The locale arrives in a form field, so it is never trusted as a path segment. */
function safeLocale(value: FormDataEntryValue | null) {
  const candidate = String(value ?? routing.defaultLocale);
  return hasLocale(routing.locales, candidate)
    ? candidate
    : routing.defaultLocale;
}

/**
 * Toggle a favorite for the caller's company. RLS (favorites_rw) guarantees the
 * company_id must be the caller's own; we still read it server-side, never from
 * the form.
 *
 * Silent on every failure path: a star that does not stick is a cosmetic loss,
 * and a throw here would blow up an otherwise fine catalog render.
 */
export async function toggleFavorite(formData: FormData) {
  const productId = String(formData.get("product_id") ?? "");
  const locale = safeLocale(formData.get("locale"));
  const on = formData.get("on") === "1";
  if (!productId) return;

  const user = await getSessionUser();
  if (!user) return;

  const supabase = await createServerSupabase();
  const { data: portalUser, error } = await supabase
    .from("portal_users")
    .select("company_id")
    .eq("id", user.id)
    .maybeSingle();
  if (error) console.error("toggleFavorite portal lookup:", error);
  if (!portalUser) return;

  if (on) {
    const { error: upsertError } = await supabase
      .from("favorites")
      .upsert({ company_id: portalUser.company_id, product_id: productId });
    if (upsertError) console.error("toggleFavorite upsert:", upsertError);
  } else {
    const { error: deleteError } = await supabase
      .from("favorites")
      .delete()
      .eq("company_id", portalUser.company_id)
      .eq("product_id", productId);
    if (deleteError) console.error("toggleFavorite delete:", deleteError);
  }

  revalidatePath(`/${locale}/catalogo`);
}
