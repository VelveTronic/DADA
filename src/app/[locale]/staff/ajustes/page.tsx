import type { Locale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { redirect } from "next/navigation";
import { StaffShell } from "@/components/staff-shell";
import { ADMIN_CARD } from "@/components/ui";
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
      {/* 940px, the mockup's own settings column (`:427`) — narrower than the
          shell's `max-w-5xl`, because a switch row is a title, a sentence and a
          44px track, and a sentence that runs the full width of a 1280px screen
          is a sentence nobody finishes reading. */}
      <div className="max-w-[940px]">
        {/* The mockup's sub-line is 供应商资料、下单规则与通知 (`:431`) and two
            thirds of it are fiction: there is no supplier-profile form and there
            are no notification switches (decision 9). What is left is what this
            page actually holds — the switches that gate the customer portal. */}
        <p className="mt-2 text-[13px] text-muted">{t("subtitle")}</p>

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
            is honest: only one form can be submitted at a time.

            OUT, and deliberately: the mockup's 供应商资料 card (`:436-460`, a
            company name / phone / warehouse / logo form backed by no table), the
            two dropdown rows inside 下单规则 (每日截单时间 and 最小起订量,
            `:666-667` — a cut-off time and a minimum order nobody has built,
            decision 3), its 通知 card (`:480-491`) and the ONE global 保存修改
            button over all of them (`:433`). That last one is not just missing
            data: `updateSetting` writes a single key per POST, so a button that
            claimed to save the whole page would save one switch (decision 9). */}
        <section className={`${ADMIN_CARD} mt-[18px]`}>
          <div className="border-b border-[#EDE9E5] px-5 py-4">
            <h2 className="text-[15px] font-bold">{t("pricesTitle")}</h2>
          </div>
          <div className="px-5 py-[18px]">
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
          </div>
        </section>

        <section className={`${ADMIN_CARD} mt-[18px]`}>
          <div className="border-b border-[#EDE9E5] px-5 py-4">
            <h2 className="text-[15px] font-bold">{t("deliveryDateTitle")}</h2>
          </div>
          <div className="px-5 py-[18px]">
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
          </div>
        </section>
      </div>
    </StaffShell>
  );
}
