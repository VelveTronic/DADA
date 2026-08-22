"use server";

import { hasLocale } from "next-intl";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { routing } from "@/i18n/routing";
import { requireStaff } from "@/lib/auth/guards";
import {
  classifyPasswordUpdateError,
  classifyReauthError,
  describeAuthError,
  validateDisplayName,
  validatePasswordChange,
  type ProfileError,
} from "@/lib/profile";
import { createServerSupabase } from "@/lib/supabase/server";
import { describeDbError } from "@/lib/user-admin";

function safeLocale(value: FormDataEntryValue | null) {
  const candidate = String(value ?? routing.defaultLocale);
  return hasLocale(routing.locales, candidate)
    ? candidate
    : routing.defaultLocale;
}

type Field = "name" | "pwd";

function finish(
  locale: string,
  field: Field,
  result: "ok" | ProfileError,
): never {
  revalidatePath(`/${locale}/staff/cuenta`);
  revalidatePath(`/${locale}/staff/usuarios`);
  redirect(`/${locale}/staff/cuenta?${field}=${result}`);
}

export async function updateStaffDisplayName(formData: FormData): Promise<void> {
  const locale = safeLocale(formData.get("locale"));
  await requireStaff(locale);

  const name = validateDisplayName(formData.get("display_name"));
  if (!name.ok) return finish(locale, "name", name.error);

  let result: "ok" | ProfileError = "ok";
  try {
    const supabase = await createServerSupabase();
    const { data, error } = await supabase.rpc("staff_update_own_display_name", {
      p_display_name: name.value,
    });
    if (error) {
      console.error("updateStaffDisplayName:", describeDbError(error));
      result = "DB_ERROR";
    } else if (data !== true) {
      console.error("updateStaffDisplayName: RPC returned false/invalid payload");
      result = "DB_ERROR";
    }
  } catch (cause) {
    console.error("updateStaffDisplayName:", describeDbError(cause));
    result = "DB_ERROR";
  }

  return finish(locale, "name", result);
}

export async function changeStaffPassword(formData: FormData): Promise<void> {
  const locale = safeLocale(formData.get("locale"));
  const { user } = await requireStaff(locale);
  if (!user.email) {
    console.error("changeStaffPassword: session has no email claim");
    return finish(locale, "pwd", "AUTH_ERROR");
  }

  const change = validatePasswordChange({
    current: formData.get("current_password"),
    next: formData.get("new_password"),
    confirm: formData.get("confirm_password"),
  });
  if (!change.ok) return finish(locale, "pwd", change.error);

  const supabase = await createServerSupabase();
  const { error: reauthError } = await supabase.auth.signInWithPassword({
    email: user.email,
    password: change.value.current,
  });
  if (reauthError) {
    console.error("changeStaffPassword reauth:", describeAuthError(reauthError));
    return finish(locale, "pwd", classifyReauthError(reauthError));
  }

  const { error: updateError } = await supabase.auth.updateUser({
    password: change.value.next,
  });
  if (updateError) {
    console.error("changeStaffPassword update:", describeAuthError(updateError));
    return finish(locale, "pwd", classifyPasswordUpdateError(updateError));
  }

  return finish(locale, "pwd", "ok");
}
