import type { Locale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Fragment } from "react";
import { AppShell } from "@/components/app-shell";
import { GLASS_CARD } from "@/components/ui";
import { beginCompanyUser, finishCompanyUser } from "@/lib/auth/guards";
import { perfRun } from "@/lib/perf";
import { getSetting } from "@/lib/settings";

export const dynamic = "force-dynamic";

/**
 * 我的配送地址 — where this restaurant's orders are delivered, read-only.
 *
 * DELIBERATELY not editable. The address the driver follows is the one in
 * Wingest, keyed to the ERP customer number; a customer editing a copy of it in
 * the portal would produce two addresses that disagree and one van at the wrong
 * door. So the card shows what DADA has on file and says who to ring — the staff
 * side gets the editing UI when there is one.
 *
 * Guarded exactly as the catalogue is (`requireCompanyUser`), and reachable only
 * from the header's 用户 menu.
 *
 * The company row is fetched HERE rather than widened into `requireCompanyUser`:
 * the guard's select is on the hot path of every customer page, and four address
 * columns nobody else renders have no business riding along on the catalogue.
 * RLS answers this one for free — `companies_select` narrows an authenticated
 * customer to their own row — and the `.eq` below says whose row out loud.
 */
export default async function AddressesPage({
  params,
}: {
  params: Promise<{ locale: Locale }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const perf = perfRun(`/${locale}/direcciones`);
  const { supabase, pendingUser } = await beginCompanyUser(locale);
  const t = await getTranslations("addresses");

  // The profile row and the owner's price switch race; neither waits on the
  // other. The switch matters here only for the phone's cart bar, which rides
  // under every customer page including this one.
  const [portalUser, showPrices] = await Promise.all([
    finishCompanyUser(pendingUser, locale),
    perf.step("settings", getSetting(supabase, "show_prices")),
  ]);

  // The address is the one read on this page that cannot join them: it is keyed
  // by `company_id`, which is what the profile row above went to fetch. RLS
  // (`companies_select`) would narrow an authenticated customer to this exact
  // row without the filter — but a query that says whose row it wants out loud
  // is worth one round trip on a page nobody opens twice a day, so the `.eq`
  // stays and the read waits.
  const { data: company, error } = await perf.step(
    "company",
    supabase
      .from("companies")
      // Enumerated, never `select('*')`: `notes` is internal and column-revoked
      // from authenticated, and a star select fails the WHOLE query with a 403.
      .select("name, address, address_city, postal_code, phone")
      .eq("id", portalUser.company_id)
      .maybeSingle(),
  );
  perf.end();
  if (error) console.error("addresses company query:", error);

  /** The four address fields, in the order an envelope is read. */
  const fields: Array<[string, string | null | undefined]> = [
    [t("street"), company?.address],
    [t("city"), company?.address_city],
    [t("postal"), company?.postal_code],
    [t("phone"), company?.phone],
  ];
  // The empty state is about the ADDRESS, not the company: the restaurant's name
  // is always there, so a card showing nothing but a name would look broken.
  const hasAddress = fields.some(([, value]) => Boolean(value?.trim()));

  return (
    <AppShell
      locale={locale}
      user={{ name: portalUser.display_name ?? portalUser.companies.name }}
      showPrices={showPrices}
    >
      <h1 className="mt-8 text-2xl font-bold tracking-tight">{t("title")}</h1>

      <section className={`${GLASS_CARD} mt-6 p-5`}>
        <h2 className="font-medium">{t("cardTitle")}</h2>

        <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-[10rem_1fr]">
          <dt className="text-muted">{t("company")}</dt>
          <dd>{company?.name ?? portalUser.companies.name}</dd>

          {/* A field DADA has not filled in is left out entirely rather than
              shown as an empty row: a label with nothing after it reads as a
              value that failed to load. */}
          {fields.map(([label, value]) =>
            value?.trim() ? (
              <Fragment key={label}>
                <dt className="text-muted">{label}</dt>
                <dd>{value}</dd>
              </Fragment>
            ) : null,
          )}
        </dl>

        {!hasAddress && (
          <p className="mt-4 text-sm text-muted">{t("empty")}</p>
        )}

        {/* Why there is no edit button here. It sits INSIDE the card, under the
            address it is about. */}
        <p className="mt-5 border-t border-border pt-4 text-xs text-muted">
          {t("note")}
        </p>
      </section>
    </AppShell>
  );
}
