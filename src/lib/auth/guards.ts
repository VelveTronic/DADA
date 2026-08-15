import "server-only";
import type { Locale } from "next-intl";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth/session";
import { createServerSupabase } from "@/lib/supabase/server";

/** Authenticated restaurant user with an active company. */
export async function requireCompanyUser(locale: Locale) {
  const user = await getSessionUser();
  if (!user) redirect(`/${locale}/login`);

  const supabase = await createServerSupabase();
  const { data: portalUser, error } = await supabase
    .from("portal_users")
    .select(
      "id, company_id, display_name, locale, is_active, companies:company_id(id, name, tarcli, is_active)",
    )
    .eq("id", user.id)
    .maybeSingle();

  if (error) console.error("requireCompanyUser:", error);
  if (!portalUser?.is_active || !portalUser.companies?.is_active) {
    redirect(`/${locale}/login?error=inactive`);
  }

  return { user, portalUser };
}

/** Authenticated active DADA staff member. */
export async function requireStaff(locale: Locale) {
  const user = await getSessionUser();
  if (!user) redirect(`/${locale}/login`);

  const supabase = await createServerSupabase();
  const { data: staffUser, error } = await supabase
    .from("staff_users")
    .select("id, role, display_name, is_active")
    .eq("id", user.id)
    .maybeSingle();

  if (error) console.error("requireStaff:", error);
  if (!staffUser?.is_active) {
    redirect(`/${locale}/login?error=inactive`);
  }

  return { user, staffUser };
}
