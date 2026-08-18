import type { Metadata, Viewport } from "next";
import { NextIntlClientProvider, hasLocale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Archivo } from "next/font/google";
import { notFound } from "next/navigation";
import { routing } from "@/i18n/routing";
import "../globals.css";

/**
 * The portal's ONE webfont, and it is not the body face: Archivo draws the
 * NUMERALS — quantities, counts, money, order numbers — through the `font-num`
 * utility that `--font-num` in `globals.css` generates. The words stay on the
 * CJK faces the customer's phone already has, because shipping a Chinese webfont
 * would cost megabytes on the 4G a restaurant orders from.
 *
 * `subsets: ["latin"]` is the whole point: digits and Latin only, self-hosted by
 * `next/font` so the browser never talks to Google.
 *
 * No `weight`, deliberately — that is what asks for the VARIABLE cut: the same
 * woff2 chunks Google serves either way (latin splits into three unicode
 * ranges), but declared once across the whole 100–900 axis instead of pinned to
 * three instances, which cut the @font-face blocks from 10 to 4. The `wdth`
 * axis Archivo also carries is left out: `axes` is opt-in, so only `wght`
 * comes down.
 */
const archivo = Archivo({
  subsets: ["latin"],
  variable: "--font-archivo",
  display: "swap",
});

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
    // The font variable goes on `<html>`, not on `<body>`, and that placement is
    // load-bearing rather than taste. `--font-num` is declared by `@theme` on
    // `:root`, and a custom property's `var()` is substituted against the element
    // it is DECLARED on: with `--font-archivo` set one level down on `<body>`,
    // `--font-num` computes to the guaranteed-invalid value at `:root`, every
    // descendant inherits that, and `font-num` silently falls back to the body
    // stack — the numerals would look right-ish and never be Archivo. Declaring
    // the variable here puts it in scope for the theme block that reads it.
    // (Next's own Tailwind example does the same.)
    <html lang={locale} className={archivo.variable}>
      <body>
        <NextIntlClientProvider>{children}</NextIntlClientProvider>
      </body>
    </html>
  );
}
