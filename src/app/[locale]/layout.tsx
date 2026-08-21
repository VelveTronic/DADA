import type { Metadata, Viewport } from "next";
import { NextIntlClientProvider, hasLocale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Inter } from "next/font/google";
import { notFound } from "next/navigation";
import { routing } from "@/i18n/routing";
import "../globals.css";

/**
 * The portal's ONE webfont, and it is not a CJK face: shipping a Chinese
 * webfont would cost megabytes on the 4G a restaurant orders from, so the
 * Chinese glyphs stay on the faces the customer's phone already has.
 *
 * **Inter**, and specifically because the owner pointed at 4seller.com and
 * asked for its type (2026-08-20). Measured off that site's computed styles:
 * body, headings and buttons are all `Inter, -apple-system, …` with NO CJK
 * webfont — their Chinese rides the system faces exactly as ours does — plus a
 * display face (Bricolage Grotesque) used only on marketing headlines, which an
 * ERP back office has no use for. Inter replaces BOTH previous webfonts: the
 * body's Latin (Noto Sans) and the numeral face (Archivo) — its tabular figures
 * are first-rate, so every `font-num`/`tabular-nums` site keeps lining up and
 * the portal ships one font instead of two.
 *
 * `subsets: ["latin"]`: digits and Latin (Spanish accents included) only,
 * self-hosted by `next/font` so the browser never talks to Google. No `weight`
 * — that is what asks for the VARIABLE cut, one declaration across 100–900.
 */
const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

/**
 * `viewport-fit=cover` is what makes `env(safe-area-inset-*)` report real
 * numbers. Without it iOS answers 0 for all four, and everything the phone's
 * bottom edge is built out of silently collapses to its zero case: the tab
 * bar's `pb-[env(safe-area-inset-bottom)]` — the strip of white that keeps the
 * home indicator off four 56px targets — becomes no padding at all; the demand
 * bar's `bottom-[calc(3.5rem+env(…)+0.5rem)]` and the catalogue's two
 * `h-[calc(7.5rem+env(…))]` scroll tails all lose the same term at once, so the
 * bars sit under the indicator and the content sits under the bars.
 *
 * Every one of those is an `env()` ADDED to a fixed number rather than a floor
 * under one — with a single deliberate exception: the cart's submit bar pads
 * itself with `max(0.875rem, env())` because a bar flush against the glass
 * takes a floor, not a sum (its reasoning lives in `carrito/page.tsx`). Turn
 * this off and the layout is wrong everywhere, visibly, at once.
 *
 * Next's defaults for width and initial-scale are kept; this only adds the fit.
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
    // it is DECLARED on: with `--font-inter` set one level down on `<body>`,
    // `--font-num` computes to the guaranteed-invalid value at `:root`, every
    // descendant inherits that, and `font-num` silently falls back to the body
    // stack. Declaring the variable here puts it in scope for the theme block
    // that reads it. (Next's own Tailwind example does the same.)
    <html lang={locale} className={inter.variable}>
      <body>
        <NextIntlClientProvider>{children}</NextIntlClientProvider>
      </body>
    </html>
  );
}
