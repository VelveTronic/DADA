import type { Locale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import Link from "next/link";
import { signOut } from "@/app/actions/auth";
import { requireStaff } from "@/lib/auth/guards";

export const dynamic = "force-dynamic";

export default async function StaffHome({
  params,
}: {
  params: Promise<{ locale: Locale }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const { staffUser } = await requireStaff(locale);
  const t = await getTranslations("staff");
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
        {staffUser.display_name ?? staffUser.id} · {staffUser.role}
      </p>
      <p className="mt-8 text-gray-400">{t("ordersQueue")}</p>
      <nav className="mt-4">
        <ul className="text-sm">
          <li>
            <Link className="underline" href={`/${locale}/staff/productos`}>
              {t("products")}
            </Link>
          </li>
        </ul>
      </nav>
    </main>
  );
}
