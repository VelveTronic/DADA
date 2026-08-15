"use server";

import { hasLocale } from "next-intl";
import { redirect } from "next/navigation";
import { routing } from "@/i18n/routing";
import { createServerSupabase } from "@/lib/supabase/server";

function safeLocale(value: FormDataEntryValue | null) {
  const candidate = String(value ?? routing.defaultLocale);
  return hasLocale(routing.locales, candidate)
    ? candidate
    : routing.defaultLocale;
}

export async function signIn(formData: FormData) {
  const locale = safeLocale(formData.get("locale"));
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  if (!email || !password) redirect(`/${locale}/login?error=invalid`);

  const supabase = await createServerSupabase();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) redirect(`/${locale}/login?error=invalid`);

  const { data: staffUser, error: staffError } = await supabase
    .from("staff_users")
    .select("is_active")
    .maybeSingle();
  if (staffError) console.error("signIn staff lookup:", staffError);
  if (staffUser) {
    if (!staffUser.is_active) {
      await supabase.auth.signOut();
      redirect(`/${locale}/login?error=inactive`);
    }
    redirect(`/${locale}/staff`);
  }

  const { data: portalUser, error: portalError } = await supabase
    .from("portal_users")
    .select("is_active, companies:company_id(is_active)")
    .maybeSingle();
  if (portalError) console.error("signIn portal lookup:", portalError);
  if (!portalUser?.is_active || !portalUser.companies?.is_active) {
    await supabase.auth.signOut();
    redirect(`/${locale}/login?error=inactive`);
  }

  redirect(`/${locale}/catalogo`);
}

export async function signOut(formData: FormData) {
  const locale = safeLocale(formData.get("locale"));
  const supabase = await createServerSupabase();
  const { error } = await supabase.auth.signOut();
  if (error && error.name !== "AuthSessionMissingError") {
    console.error("signOut:", error);
  }
  redirect(`/${locale}/login`);
}
