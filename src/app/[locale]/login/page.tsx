import type { Locale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { LoginForm } from "./login-form";

export default async function LoginPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: Locale }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { locale } = await params;
  const { error } = await searchParams;
  setRequestLocale(locale);
  const t = await getTranslations("login");

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 p-6">
      <h1 className="text-2xl font-bold">{t("title")}</h1>
      {error === "invalid" && (
        <p role="alert" className="text-sm text-red-600">
          {t("errorInvalid")}
        </p>
      )}
      {error === "inactive" && (
        <p role="alert" className="text-sm text-red-600">
          {t("errorInactive")}
        </p>
      )}
      <LoginForm
        locale={locale}
        labels={{
          email: t("email"),
          password: t("password"),
          submit: t("submit"),
        }}
      />
    </main>
  );
}
