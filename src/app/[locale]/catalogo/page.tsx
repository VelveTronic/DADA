import type { Locale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { signOut } from "@/app/actions/auth";
import { requireCompanyUser } from "@/lib/auth/guards";

export const dynamic = "force-dynamic";

export default async function CatalogPage({
  params,
}: {
  params: Promise<{ locale: Locale }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const { portalUser } = await requireCompanyUser(locale);
  const t = await getTranslations("catalog");
  const tc = await getTranslations("common");

  return (
    <main className="mx-auto max-w-4xl p-6">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-bold">{t("title")}</h1>
        <form action={signOut}>
          <input type="hidden" name="locale" value={locale} />
          <button type="submit" className="text-sm underline">
            {tc("logout")}
          </button>
        </form>
      </div>
      <p className="mt-2 text-sm text-gray-500">
        {portalUser.display_name ?? portalUser.companies.name}
      </p>
      <p className="mt-8 text-gray-400">{t("empty")}</p>
    </main>
  );
}
