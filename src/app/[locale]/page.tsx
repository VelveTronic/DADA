import type { Locale } from "next-intl";
import { setRequestLocale } from "next-intl/server";
import { redirect } from "@/i18n/navigation";

/**
 * `params.locale` is typed `Locale` rather than `string` because
 * `[locale]/layout.tsx` runs `hasLocale` + `notFound()` before any page in this
 * segment renders — the same contract TOKACHI's pages rely on.
 */
export default async function Home({
  params,
}: {
  params: Promise<{ locale: Locale }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  redirect({ href: "/catalogo", locale });
}
