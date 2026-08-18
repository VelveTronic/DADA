import type { Locale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { AppShell } from "@/components/app-shell";
import { CARD } from "@/components/ui";
import { beginCompanyUser, finishCompanyUser } from "@/lib/auth/guards";
import { perfRun } from "@/lib/perf";
import { isProfileResult, type ProfileResult } from "@/lib/profile";
import { getSetting } from "@/lib/settings";
import { DisplayNameForm, PasswordForm } from "./profile-forms";

export const dynamic = "force-dynamic";

/**
 * 我的信息 — what the portal knows about the person signed in, and the two
 * things they may change about it.
 *
 * Reachable only from the header's 用户 menu, and guarded exactly as the
 * catalogue is: `requireCompanyUser` sends a signed-out visitor to the login
 * page and a deactivated account (or one whose restaurant has been deactivated)
 * to `?error=inactive`. A staff member has no `portal_users` row, so this page
 * is not theirs either.
 *
 * READ-ONLY here: the email (changing the login address is a support job, not a
 * self-service one — it is the identity every order was placed under) and the
 * restaurant's name, which DADA maintains alongside its ERP customer number.
 *
 * The two forms answer independently through `?name=` and `?pwd=`, so a rejected
 * password never puts a red banner over the name the customer just saved.
 */
export default async function ProfilePage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: Locale }>;
  searchParams: Promise<{ name?: string; pwd?: string }>;
}) {
  const { locale } = await params;
  const { name: rawName, pwd: rawPwd } = await searchParams;
  setRequestLocale(locale);
  const perf = perfRun(`/${locale}/perfil`);
  const { user, supabase, pendingUser } = await beginCompanyUser(locale);
  const t = await getTranslations("profile");
  // The eye toggle's two labels are the login page's; reused rather than
  // duplicated into a second namespace.
  const tLogin = await getTranslations("login");

  // Both parameters are user-editable, so each is proved to be one of the known
  // codes BEFORE it is used as a message key — a raw value would render as
  // whatever the URL said.
  const rawNameText = rawName ?? "";
  const rawPwdText = rawPwd ?? "";
  const nameResult = isProfileResult(rawNameText) ? rawNameText : null;
  const pwdResult = isProfileResult(rawPwdText) ? rawPwdText : null;

  // This page prices nothing, but the phone's cart bar rides under every
  // customer page — and with the owner's switch off it must not show the
  // subtotal slot at all, here as anywhere else.
  //
  // It used to be read on a line of its own, AFTER the guard had finished: a
  // page whose whole content is already in hand paying a second full round trip
  // for one boolean. It now goes out beside the profile row, which is the rule
  // everywhere else in the portal.
  const [portalUser, showPrices] = await Promise.all([
    finishCompanyUser(pendingUser, locale),
    perf.step("settings", getSetting(supabase, "show_prices")),
  ]);
  perf.end();

  const banner = (result: ProfileResult | null) =>
    result && (
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
    );

  return (
    <AppShell
      locale={locale}
      user={{ name: portalUser.display_name ?? portalUser.companies.name }}
      showPrices={showPrices}
    >
      <h1 className="mt-8 text-2xl font-bold tracking-tight">{t("title")}</h1>

      <section className={`${CARD} mt-6 p-5`}>
        <h2 className="font-medium">{t("accountTitle")}</h2>

        <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-[10rem_1fr]">
          <dt className="text-muted">{t("email")}</dt>
          {/* `break-all`: an address is one unbreakable token to a browser, and
              a long one would otherwise widen the card past a phone. */}
          <dd className="break-all">{user.email ?? "—"}</dd>

          <dt className="text-muted">{t("company")}</dt>
          <dd>{portalUser.companies.name}</dd>
        </dl>
        <p className="mt-3 text-xs text-muted">{t("emailHint")}</p>

        {banner(nameResult)}

        <DisplayNameForm
          locale={locale}
          displayName={portalUser.display_name ?? ""}
          labels={{
            displayName: t("displayName"),
            displayNameHint: t("displayNameHint"),
            save: t("save"),
          }}
        />
      </section>

      <section className={`${CARD} mt-6 p-5`}>
        <h2 className="font-medium">{t("passwordTitle")}</h2>

        {banner(pwdResult)}

        <PasswordForm
          locale={locale}
          labels={{
            currentPassword: t("currentPassword"),
            newPassword: t("newPassword"),
            confirmPassword: t("confirmPassword"),
            passwordHint: t("passwordHint"),
            changePassword: t("changePassword"),
            showPassword: tLogin("showPassword"),
            hidePassword: tLogin("hidePassword"),
          }}
        />
      </section>
    </AppShell>
  );
}
