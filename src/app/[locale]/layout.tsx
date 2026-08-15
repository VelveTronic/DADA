import type { Metadata, Viewport } from "next";
import { NextIntlClientProvider, hasLocale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { routing } from "@/i18n/routing";
import "../globals.css";

/**
 * `viewport-fit=cover` is what makes `env(safe-area-inset-*)` report real
 * numbers. Without it iOS answers 0 for all four, so the mobile cart bar's
 * `pb-[max(0.75rem,env(safe-area-inset-bottom))]` silently collapses to the
 * 0.75rem floor and the bar sits under the home indicator on every notched
 * iPhone. Next's defaults for width and initial-scale are kept; this only adds
 * the fit.
 */
export const viewport: Viewport = { viewportFit: "cover" };

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

/**
 * `hasLocale` narrows `string` to the `Locale` union that `getTranslations`
 * requires (see `src/global.d.ts`), and doubles as the 404 guard: metadata is
 * generated alongside the layout below, not after it, so an unknown locale has
 * to be rejected in both places.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) {
    notFound();
  }
  const t = await getTranslations({ locale, namespace: "common" });

  return {
    title: { default: t("appName"), template: `%s | ${t("appName")}` },
    description: t("metaDescription"),
  };
}

export default async function LocaleLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) {
    notFound();
  }
  setRequestLocale(locale);

  return (
    <html lang={locale}>
      <body>
        <NextIntlClientProvider>{children}</NextIntlClientProvider>
      </body>
    </html>
  );
}
