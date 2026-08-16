"use server";

import { hasLocale } from "next-intl";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { routing } from "@/i18n/routing";
import { requireStaff } from "@/lib/auth/guards";
import {
  parseSettingInput,
  parseSettingKey,
  type SettingsError,
} from "@/lib/settings";
import { createAdminClient } from "@/lib/supabase/admin";
import { canManageStaff } from "@/lib/user-admin";

/**
 * The one write against `portal_settings`, and the only reason that table has no
 * authenticated write policy at all.
 *
 * The order is `staff-users.ts`'s, for the same reasons:
 *
 *   requireStaff(locale)     → who is asking, and are they still active
 *   canManageStaff(role)     → owner only; a Server Action is an open POST
 *                              endpoint, so the page hiding the tab proves nothing
 *   parseSettingKey/Input    → is the request even about a setting we have
 *
 * Only then is the admin client created. It bypasses RLS completely — that is
 * why the two gates above are not optimisations.
 *
 * The KEY is never trusted past registry membership: the form posts it in a
 * hidden field, and an unknown key is refused rather than inserted, so nothing
 * can seed the table with rows the reader would then have to defend against.
 */

/** The locale arrives in a form field, so it is never trusted as a path segment. */
function safeLocale(value: FormDataEntryValue | null) {
  const candidate = String(value ?? routing.defaultLocale);
  return hasLocale(routing.locales, candidate)
    ? candidate
    : routing.defaultLocale;
}

/**
 * Where a saved (or refused) setting lands: back on the page, carrying the one
 * word it needs to draw its banner — the `?result=<CODE>` convention
 * `staff-users.ts` and `staff-orders.ts` already use.
 *
 * Returns `never` because `redirect()` works by THROWING NEXT_REDIRECT, so no
 * caller may wrap it in a try/catch that swallows errors.
 */
function finish(locale: string, result: "ok" | SettingsError): never {
  // The page the owner is looking at, so the toggle redraws from the row that
  // was just written rather than from the one this render started with.
  revalidatePath(`/${locale}/staff/ajustes`);
  // The customer pages that render an amount. They are all `force-dynamic`, so
  // the SERVER re-reads the setting on every request regardless — this clears
  // the client-side Router Cache, which is the copy that would otherwise let a
  // customer navigate back to a catalogue rendered under the old flag. Both
  // locales, because a restaurant's language is not the owner's.
  for (const other of routing.locales) {
    for (const path of ["catalogo", "carrito", "pedidos"]) {
      revalidatePath(`/${other}/${path}`);
    }
  }
  redirect(`/${locale}/staff/ajustes?result=${result}`);
}

/**
 * The toggle's value, from the hidden/checkbox pair the form posts.
 *
 * A checkbox sends NOTHING when it is off, so the form pairs it with a hidden
 * `0` that is always sent (the classic Rails/Django idiom, see
 * `settings-form.tsx`). Both fields carry the same name, so the browser posts
 * `0` alone when the switch is off and `0, 1` when it is on — the LAST entry is
 * the answer, and `FormData.get` would always return the first.
 *
 * The alternative, reading an absent field as `false`, is exactly the guess
 * `parseSettingInput` refuses to make: a truncated body would then read as "hide
 * every price from every restaurant".
 */
function lastValue(formData: FormData, name: string): FormDataEntryValue | null {
  const values = formData.getAll(name);
  return values.length > 0 ? values[values.length - 1] : null;
}

/**
 * Save one setting. Owner only.
 *
 * `upsert` rather than `update`: the seeded row exists, but a settings write
 * that silently matched nothing would leave the owner looking at a success
 * banner over the value they just tried to change. `updated_at` is stamped here
 * because the column's default only fires on the insert half.
 */
export async function updateSetting(formData: FormData): Promise<void> {
  const locale = safeLocale(formData.get("locale"));
  const { staffUser } = await requireStaff(locale);
  // Fails CLOSED with a throw, not a redirect: a caller without the role never
  // rendered this page, so there is no banner to send them back to.
  if (!canManageStaff(staffUser.role)) throw new Error("FORBIDDEN");

  const key = parseSettingKey(formData.get("key"));
  if (!key.ok) return finish(locale, key.error);

  const value = parseSettingInput(key.value, lastValue(formData, "value"));
  if (!value.ok) return finish(locale, value.error);

  const admin = createAdminClient();
  const { error } = await admin
    .from("portal_settings")
    .upsert(
      {
        key: key.value,
        value: value.value,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "key" },
    );
  if (error) {
    console.error("updateSetting:", error);
    return finish(locale, "DB_ERROR");
  }

  return finish(locale, "ok");
}
