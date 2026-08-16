import type { Locale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import Image from "next/image";
import { GLASS_CARD } from "@/components/ui";
import { perfRun } from "@/lib/perf";
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
  // The only page in the portal that reads NOTHING, which is exactly why it is
  // instrumented: its line is the floor — routing, i18n and the render, with no
  // database in it — so every other page's line can be read as "the floor plus
  // these round trips" rather than as a number with nothing to compare it to.
  // It is also the one line reachable without signing in.
  const perf = perfRun(`/${locale}/login`);
  const t = await getTranslations("login");
  perf.end();

  return (
    // The one page with no AppShell: there is nobody signed in yet, so a header
    // of nav links and a logout button would have nothing to offer. The brand
    // mark carries the identity instead.
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 p-6">
      <div className="flex flex-col items-center gap-3">
        {/* Sized by CSS in its own square aspect; the width/height pair is only
            the intrinsic ratio. `sizes` is what keeps the optimizer from
            shipping a 1080px source for a 64px mark. */}
        <Image
          src="/brand/dada-logo.png"
          alt="DADA"
          width={512}
          height={512}
          sizes="64px"
          className="h-16 w-16"
          priority
        />
        <h1 className="text-2xl font-bold tracking-tight">{t("title")}</h1>
      </div>
      {error === "invalid" && (
        <p
          role="alert"
          className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {t("errorInvalid")}
        </p>
      )}
      {error === "inactive" && (
        <p
          role="alert"
          className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {t("errorInactive")}
        </p>
      )}
      <div className={`${GLASS_CARD} p-6`}>
        <LoginForm
          locale={locale}
          labels={{
            email: t("email"),
            password: t("password"),
            submit: t("submit"),
            showPassword: t("showPassword"),
            hidePassword: t("hidePassword"),
          }}
        />
      </div>
    </main>
  );
}
