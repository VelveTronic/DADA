import type { Locale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { GLASS_CARD } from "@/components/ui";
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

  const sections = [
    { href: `/${locale}/staff/pedidos`, label: t("ordersQueue") },
    { href: `/${locale}/staff/productos`, label: t("products") },
  ];

  return (
    <AppShell
      locale={locale}
      nav="staff"
      user={{
        name: staffUser.display_name ?? staffUser.id,
        detail: staffUser.role,
      }}
    >
      <h1 className="mt-8 text-2xl font-bold tracking-tight">{t("title")}</h1>
      <nav className="mt-6">
        <ul className="grid gap-4 sm:grid-cols-2">
          {sections.map((section) => (
            <li key={section.href}>
              <Link
                href={section.href}
                className={`${GLASS_CARD} flex items-center justify-between gap-4 p-5 font-medium transition-colors hover:border-brand hover:text-brand-ink`}
              >
                {section.label}
                <span aria-hidden="true" className="text-brand-ink">
                  →
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </AppShell>
  );
}
