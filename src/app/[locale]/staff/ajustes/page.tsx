import type { Locale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { GLASS_CARD } from "@/components/ui";
import { requireStaff } from "@/lib/auth/guards";
import { getSetting, isSettingsResult } from "@/lib/settings";
import { createServerSupabase } from "@/lib/supabase/server";
import { canManageStaff } from "@/lib/user-admin";
import { SettingsForm } from "./settings-form";

export const dynamic = "force-dynamic";

/**
 * 项目设置 — the owner's switches. Today: whether customers see prices.
 *
 * Owner only, and the redirect is what makes the nav entry's absence honest: a
 * manager who types the URL lands back on the staff home rather than on a page
 * with a control they may not use. `updateSetting` repeats the same gate for the
 * POST that skipped the page.
 *
 * The read goes through the ORDINARY session client. `portal_settings` grants
 * `authenticated` a SELECT that RLS opens to everyone — that is the whole point
 * of the table, since customer pages read the same row — so the service-role
 * client would buy nothing here and would throw wherever
 * `SUPABASE_SERVICE_ROLE_KEY` is absent.
 */
export default async function StaffSettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: Locale }>;
  searchParams: Promise<{ result?: string }>;
}) {
  const { locale } = await params;
  const { result: rawResult } = await searchParams;
  setRequestLocale(locale);
  const { staffUser } = await requireStaff(locale);
  if (!canManageStaff(staffUser.role)) redirect(`/${locale}/staff`);

  const t = await getTranslations("staff.settings");

  // The action redirects with `?result=<CODE>`. The parameter is user-editable,
  // so it is proved to be one of the known codes BEFORE it is used as a message
  // key — a raw value would render as whatever the URL said.
  const raw = rawResult ?? "";
  const result = isSettingsResult(raw) ? raw : null;

  const supabase = await createServerSupabase();
  const showPrices = await getSetting(supabase, "show_prices");

  return (
    <AppShell
      locale={locale}
      nav="staff"
      user={{
        name: staffUser.display_name ?? staffUser.id,
        role: staffUser.role,
      }}
    >
      <h1 className="mt-8 text-2xl font-bold tracking-tight">{t("title")}</h1>

      {result && (
        <p
          role={result === "ok" ? "status" : "alert"}
          className={`mt-4 rounded-lg px-3 py-2 text-sm ${
            result === "ok"
              ? "bg-green-50 text-green-800"
              : "bg-red-50 text-red-700"
          }`}
        >
          {t(`results.${result}`)}
        </p>
      )}

      <section className={`${GLASS_CARD} mt-6 p-5`}>
        <h2 className="font-medium">{t("pricesTitle")}</h2>
        <SettingsForm
          locale={locale}
          showPrices={showPrices}
          labels={{
            showPrices: t("showPrices"),
            showPricesHint: t("showPricesHint"),
            save: t("save"),
          }}
        />
      </section>
    </AppShell>
  );
}
