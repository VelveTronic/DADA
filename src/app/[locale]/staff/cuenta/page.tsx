import type { Locale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import Link from "next/link";
import {
  changeStaffPassword,
  updateStaffDisplayName,
} from "@/app/actions/staff-profile";
import { DisplayNameForm, PasswordForm } from "@/app/[locale]/perfil/profile-forms";
import { StaffShell } from "@/components/staff-shell";
import { ADMIN_CARD, BTN_QUIET } from "@/components/ui";
import { requireStaff } from "@/lib/auth/guards";
import { isProfileResult, type ProfileResult } from "@/lib/profile";

export const dynamic = "force-dynamic";

export default async function StaffAccountPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: Locale }>;
  searchParams: Promise<{ name?: string; pwd?: string }>;
}) {
  const { locale } = await params;
  const { name: rawName, pwd: rawPwd } = await searchParams;
  setRequestLocale(locale);
  const { user, staffUser } = await requireStaff(locale);
  const t = await getTranslations("staff.account");
  const tProfile = await getTranslations("profile");
  const tLogin = await getTranslations("login");

  const nameResult = isProfileResult(rawName ?? "") ? (rawName as ProfileResult) : null;
  const passwordResult = isProfileResult(rawPwd ?? "")
    ? (rawPwd as ProfileResult)
    : null;
  const displayName = staffUser.display_name ?? user.email ?? staffUser.id;

  const banner = (result: ProfileResult | null) =>
    result && (
      <p
        role={result === "ok" ? "status" : "alert"}
        className={`mx-4 mt-4 rounded-lg px-3 py-2 text-sm ${
          result === "ok"
            ? "bg-green-50 text-green-800"
            : "bg-red-50 text-red-700"
        }`}
      >
        {tProfile(`results.${result}`)}
      </p>
    );

  return (
    <StaffShell
      locale={locale}
      title={t("title")}
      breadcrumb={t("breadcrumb")}
      user={{ name: displayName, role: staffUser.role }}
    >
      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        <section className={ADMIN_CARD}>
          <h2 className="border-b border-border px-4 py-4 font-bold">
            {t("languageTitle")}
          </h2>
          <div className="flex flex-wrap gap-2 p-4">
            <Link
              href="/zh/staff/cuenta"
              aria-current={locale === "zh" ? "page" : undefined}
              className={`${BTN_QUIET} ${locale === "zh" ? "border-brand/30 text-brand-ink" : ""}`}
            >
              中文
            </Link>
            <Link
              href="/es/staff/cuenta"
              aria-current={locale === "es" ? "page" : undefined}
              className={`${BTN_QUIET} ${locale === "es" ? "border-brand/30 text-brand-ink" : ""}`}
            >
              Español
            </Link>
          </div>
        </section>

        <section className={ADMIN_CARD}>
          <h2 className="border-b border-border px-4 py-4 font-bold">
            {t("exportsTitle")}
          </h2>
          <div className="grid gap-2 p-4 sm:grid-cols-2">
            <a className={BTN_QUIET} href={`/${locale}/staff/export/productos`}>
              {t("exportProducts")}
            </a>
            <a className={BTN_QUIET} href={`/${locale}/staff/export/pedidos`}>
              {t("exportOrders")}
            </a>
          </div>
          <p className="px-4 pb-4 text-xs text-muted">{t("exportsHint")}</p>
        </section>

        <section className={ADMIN_CARD}>
          <h2 className="border-b border-border px-4 py-4 font-bold">
            {t("profileTitle")}
          </h2>
          <div className="px-4 pt-4 text-sm">
            <span className="text-muted">{t("email")}</span>
            <p className="mt-1 break-all font-medium">{user.email ?? "—"}</p>
          </div>
          {banner(nameResult)}
          <DisplayNameForm
            locale={locale}
            displayName={staffUser.display_name ?? ""}
            action={updateStaffDisplayName}
            labels={{
              displayName: tProfile("displayName"),
              displayNameHint: tProfile("displayNameHint"),
              save: tProfile("save"),
            }}
          />
        </section>

        <section className={ADMIN_CARD}>
          <h2 className="border-b border-border px-4 py-4 font-bold">
            {t("passwordTitle")}
          </h2>
          {banner(passwordResult)}
          <PasswordForm
            locale={locale}
            action={changeStaffPassword}
            labels={{
              currentPassword: tProfile("currentPassword"),
              newPassword: tProfile("newPassword"),
              confirmPassword: tProfile("confirmPassword"),
              passwordHint: tProfile("passwordHint"),
              changePassword: tProfile("changePassword"),
              showPassword: tLogin("showPassword"),
              hidePassword: tLogin("hidePassword"),
            }}
          />
        </section>
      </div>
    </StaffShell>
  );
}
