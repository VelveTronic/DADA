"use server";

import { hasLocale } from "next-intl";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { routing } from "@/i18n/routing";
import { requireCompanyUser } from "@/lib/auth/guards";
import {
  classifyPasswordUpdateError,
  classifyReauthError,
  describeAuthError,
  validateDisplayName,
  validatePasswordChange,
  type ProfileError,
} from "@/lib/profile";
import { createAdminClient } from "@/lib/supabase/admin";
import { createServerSupabase } from "@/lib/supabase/server";
import { describeDbError } from "@/lib/user-admin";

/**
 * The two writes a restaurant may make about ITSELF: its display name and its
 * password.
 *
 * Both actions answer the same question first — `requireCompanyUser`, which
 * proves there is a session, that the `portal_users` row is active and that the
 * company is too — and both then use the id THAT returned. Nothing here reads an
 * id, an email or a company from the form. A Server Action is its own POST
 * endpoint; a form field naming whose row to update would be an invitation.
 *
 * The two halves reach the database very differently, and the difference is not
 * a preference:
 *
 * - **Display name → service-role client.** Checked against the live project
 *   before writing this: `portal_users` has `portal_users_select` (own row or
 *   staff) but its only UPDATE policy is `portal_users_staff_update`, gated on
 *   `private.is_staff()`. There is NO self-update policy, so the customer's own
 *   session simply cannot write this column — an authenticated update matches no
 *   policy and silently affects zero rows, which would show the customer a
 *   success banner over the name they failed to change. The service-role client
 *   is therefore the only way, and it is keyed to `user.id` and filtered
 *   `.eq("id", user.id)` — the session's own uuid, never a form's.
 * - **Password → the customer's OWN session.** No admin client anywhere near it.
 *   `signInWithPassword` re-authenticates with the SESSION's email (see
 *   `getSessionUser`) and the password just typed, and `auth.updateUser` then
 *   runs as the logged-in user. Doing this with `auth.admin.updateUserById`
 *   would let anyone holding a session change the password without knowing the
 *   current one, which is the whole point of asking for it.
 *
 * **Passwords go from the form to Supabase Auth and nowhere else.** Not into a
 * log line (`describeAuthError` reads only `code` and `message` off the error),
 * not into a redirect, not into a returned value, not into anything
 * `revalidatePath` re-renders. Every outcome that travels is a CODE.
 */

/** The locale arrives in a form field, so it is never trusted as a path segment. */
function safeLocale(value: FormDataEntryValue | null) {
  const candidate = String(value ?? routing.defaultLocale);
  return hasLocale(routing.locales, candidate)
    ? candidate
    : routing.defaultLocale;
}

/** Which card on /perfil an outcome belongs to; each draws its own banner. */
type ProfileField = "name" | "pwd";

/**
 * Back to 我的信息, carrying the one word the card needs — the `?<field>=<CODE>`
 * twin of the `?result=` convention `staff-users.ts` and `staff-settings.ts` use.
 * Two parameters rather than one because the page has two independent forms, and
 * a single `result` would put the password's answer under the name's box.
 *
 * The display name is printed in the header of every customer page, so a
 * successful rename revalidates them all — in THIS locale only: the change is
 * personal, and the customer has exactly one language in their URL.
 *
 * Returns `never` because `redirect()` works by THROWING NEXT_REDIRECT, so no
 * caller may wrap it in a try/catch that swallows errors.
 */
function finish(
  locale: string,
  field: ProfileField,
  result: "ok" | ProfileError,
): never {
  for (const path of ["catalogo", "carrito", "pedidos", "perfil", "direcciones"]) {
    revalidatePath(`/${locale}/${path}`);
  }
  redirect(`/${locale}/perfil?${field}=${result}`);
}

/** 显示名称 — the name the header greets this restaurant by. Their own row only. */
export async function updateDisplayName(formData: FormData): Promise<void> {
  const locale = safeLocale(formData.get("locale"));
  const { user } = await requireCompanyUser(locale);

  const name = validateDisplayName(formData.get("display_name"));
  if (!name.ok) return finish(locale, "name", name.error);

  const admin = createAdminClient();
  const { error } = await admin
    .from("portal_users")
    .update({ display_name: name.value })
    // The session's uuid, the only id this action will ever accept. `.eq` and
    // not `.match` on anything the form sent: the admin client has no RLS left
    // to catch a mistake here.
    .eq("id", user.id);

  if (error) {
    console.error("updateDisplayName:", describeDbError(error));
    return finish(locale, "name", "DB_ERROR");
  }

  return finish(locale, "name", "ok");
}

/**
 * 修改密码 — current password, new password twice.
 *
 * The order is the security property: validate, then PROVE the current password
 * by signing in with it, then change it. A failed re-authentication leaves the
 * existing session untouched (a refused `signInWithPassword` writes no cookies),
 * so a wrong guess costs the customer a banner and nothing else.
 */
export async function changePassword(formData: FormData): Promise<void> {
  const locale = safeLocale(formData.get("locale"));
  const { user } = await requireCompanyUser(locale);

  // The address comes off the validated JWT claims, never off the form. A
  // session whose token carries no email claim cannot be re-authenticated at
  // all, and guessing an address would mean testing a password against somebody
  // else's account.
  if (!user.email) {
    console.error("changePassword: session has no email claim");
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
    // The code and the message only — the credentials that produced them are
    // not part of the log line.
    console.error("changePassword reauth:", describeAuthError(reauthError));
    return finish(locale, "pwd", classifyReauthError(reauthError));
  }

  const { error: updateError } = await supabase.auth.updateUser({
    password: change.value.next,
  });
  if (updateError) {
    console.error("changePassword update:", describeAuthError(updateError));
    return finish(locale, "pwd", classifyPasswordUpdateError(updateError));
  }

  return finish(locale, "pwd", "ok");
}
