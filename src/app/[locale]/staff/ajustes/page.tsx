import type { Locale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { redirect } from "next/navigation";
import { StaffShell } from "@/components/staff-shell";
import { GLASS_CARD } from "@/components/ui";
import { beginStaff, finishStaff } from "@/lib/auth/guards";
import { perfRun } from "@/lib/perf";
import { getSetting, isSettingsResult } from "@/lib/settings";
import { canManageStaff } from "@/lib/user-admin";
import { SettingsForm } from "./settings-form";

export const dynamic = "force-dynamic";

/**
 * 项目设置 — the owner's switches. Today: whether customers see prices, and
 * whether checkout offers a delivery-date picker.
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
  const perf = perfRun(`/${locale}/staff/ajustes`);
  const { supabase, pendingStaff } = await beginStaff(locale);

  // The switches' current values go out beside the staff row rather than behind
  // it. Nothing is relaxed by that: `portal_settings_read` opens these rows to
  // EVERY authenticated caller — customer pages read the same ones — so it is
  // not a privilege the owner gate below is protecting. What the gate protects
  // is the forms, and it still fires before any of them is rendered.
  //
  // Two reads, one round: `perf.step` wraps the PAIR, so the page line keeps
  // saying what the settings cost this render rather than growing a timing per
  // switch as the registry grows.
  const [staffUser, [showPrices, showDeliveryDate]] = await Promise.all([
    finishStaff(pendingStaff, locale),
    perf.step(
      "settings",
      Promise.all([
        getSetting(supabase, "show_prices"),
        getSetting(supabase, "show_delivery_date"),
      ]),
    ),
  ]);
  // The owner gate comes BEFORE perf.end(): a redirected request must print no
  // page line, and "a manager on an owner-only page" is the README's own example.
  if (!canManageStaff(staffUser.role)) redirect(`/${locale}/staff`);
  perf.end();

  const t = await getTranslations("staff.settings");
  // Only for the shell's breadcrumb, which speaks the sidebar's vocabulary.
  const tStaff = await getTranslations("staff");

  // The action redirects with `?result=<CODE>`. The parameter is user-editable,
  // so it is proved to be one of the known codes BEFORE it is used as a message
  // key — a raw value would render as whatever the URL said.
  const raw = rawResult ?? "";
  const result = isSettingsResult(raw) ? raw : null;

  return (
    <StaffShell
      locale={locale}
      title={t("title")}
      breadcrumb={tStaff("nav.settings")}
      user={{
        name: staffUser.display_name ?? staffUser.id,
        role: staffUser.role,
      }}
    >
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

      {/* One card per switch, each with its own 保存. The banner above is
          shared because a save redirects here with a single `?result=` — which
          is honest: only one form can be submitted at a time. */}
      <section className={`${GLASS_CARD} mt-6 p-5`}>
        <h2 className="font-medium">{t("pricesTitle")}</h2>
        <SettingsForm
          locale={locale}
          settingKey="show_prices"
          checked={showPrices}
          labels={{
            label: t("showPrices"),
            hint: t("showPricesHint"),
            save: t("save"),
          }}
        />
      </section>

      <section className={`${GLASS_CARD} mt-6 p-5`}>
        <h2 className="font-medium">{t("deliveryDateTitle")}</h2>
        <SettingsForm
          locale={locale}
          settingKey="show_delivery_date"
          checked={showDeliveryDate}
          labels={{
            label: t("showDeliveryDate"),
            hint: t("showDeliveryDateHint"),
            save: t("save"),
          }}
        />
      </section>
    </StaffShell>
  );
}
