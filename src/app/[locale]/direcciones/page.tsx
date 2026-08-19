import type { Locale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { CARD } from "@/components/ui";
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
 * side gets the editing UI when there is one. That is also why design 07's `›`
 * chevrons are absent from the rows below: every one of them is a FACT, not a
 * link, and a chevron on a row that goes nowhere is a press that does nothing.
 *
 * Guarded exactly as the catalogue is (`requireCompanyUser`), reached from the
 * account hub, and the tab bar's 我的 stays lit here (`nav-tabs.ts`) — so the
 * title row's chevron leads back to `/cuenta`.
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
  // The way BACK is the order history's string: 返回我的账户 is one wording in
  // this portal, held in the namespace that first needed it.
  const tOrders = await getTranslations("orders");

  // The profile row and the owner's price switch race; neither waits on the
  // other. The switch is read here because `AppShell`'s contract asks every
  // customer page for it — NOT because this screen shows a price or floats a
  // bar. The demand bar renders on 分类 and 搜索 only (`cart/cart-bar.tsx`
  // returns null on every other tab), so on this page the setting is threaded
  // through and nothing downstream of it draws.
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

  const clean = (value: string | null | undefined) => value?.trim() || null;

  /**
   * The three address columns as ONE line, which is what design 07's 地址 row
   * holds — and composed from the parts that are actually there, so a company
   * with no postal code reads "Calle Mayor 12, Madrid" rather than
   * "Calle Mayor 12, , Madrid".
   *
   * POSTAL CODE BEFORE THE TOWN, which is the order a Spanish envelope is
   * written in ("28001 Madrid") and the reason the two of them are joined by a
   * space and not by the comma that separates them from the street. The data is
   * Spanish whichever language the customer reads the page in.
   */
  const addressLine =
    [
      clean(company?.address),
      [clean(company?.postal_code), clean(company?.address_city)]
        .filter(Boolean)
        .join(" "),
    ]
      .filter(Boolean)
      .join(", ") || null;

  const phone = clean(company?.phone);

  /** The store's facts, in the order design 07 reads them. */
  const rows: Array<[string, string | null]> = [
    // The company name is the one row that is never missing: the guard already
    // carries it, so a failed company read still names the restaurant.
    [t("company"), clean(company?.name) ?? portalUser.companies.name],
    // Who DADA rings, which is the account's own display name — optional on a
    // `portal_users` row, so this line comes and goes with it.
    [t("contact"), clean(portalUser.display_name)],
    [t("phone"), phone],
    [t("address"), addressLine],
  ];

  // The empty state is about the ADDRESS, not the company: the restaurant's name
  // is always there, so a card showing nothing but a name would look broken.
  const hasAddress = Boolean(addressLine) || Boolean(phone);

  return (
    <AppShell
      locale={locale}
      user={{ name: portalUser.display_name ?? portalUser.companies.name }}
      showPrices={showPrices}
    >
      {/* The title row and the way back up, the same one /pedidos and /perfil
          draw — the mockup's white header band as an in-flow row on the page's
          own ground, under the shell's real header. */}
      <div className="flex items-center gap-1 pt-3">
        <Link
          href={`/${locale}/cuenta`}
          aria-label={tOrders("back")}
          className="-ml-2.5 flex size-11 shrink-0 items-center justify-center text-2xl leading-none text-ink-soft transition-colors hover:text-brand-ink"
        >
          ‹
        </Link>
        <h1 className="min-w-0 truncate text-lg font-bold">{t("title")}</h1>
      </div>

      {/* 门店资料 — design 07's key/value card. The head is `text-faint`, the
          mockup's own #A8A099, and that is the LICENSED use of the token
          (`globals.css`): it labels a group whose rows say what they are on
          their own — a street beside 地址, a phone number beside 联系电话 — i.e.
          supplementary text, the same licence /cuenta's row hints hold. It is
          never body copy, and it only ever sits on this white card. */}
      <section className={`${CARD} mt-3`}>
        <h2 className="px-4 pt-3 pb-1 text-xs font-semibold text-faint">
          {t("sectionStore")}
        </h2>

        {/* A field DADA has not filled in is left out entirely rather than
            shown as an empty row: a label with nothing after it reads as a
            value that failed to load. */}
        {rows.map(([label, value]) =>
          value ? (
            <div
              key={label}
              className="flex min-h-[52px] items-center gap-3 border-t border-border px-4 py-3 text-sm"
            >
              <span className="w-[76px] flex-none text-[13px] text-muted">
                {label}
              </span>
              {/* `min-w-0` so a long street can wrap inside the row instead of
                  pushing the card wider than the phone. */}
              <span className="min-w-0 flex-1 text-right leading-snug">
                {value}
              </span>
            </div>
          ) : null,
        )}

        {!hasAddress && (
          <p className="border-t border-border px-4 py-3 text-sm text-muted">
            {t("empty")}
          </p>
        )}
      </section>

      {/* Why there is no edit button on this screen, as design 07's wash card.
          The two colours are the mockup's own one-off tint — a hair lighter and
          warmer than `brand-soft` (#FDECEA), which is the chip fill and would
          read as a control here — so they are written as literals rather than
          promoted to palette entries, the same call `/cuenta` makes for its
          chevron grey. The HEAD's #B31710 is not a literal: that one IS the
          palette's `brand-ink`, the shade this repo uses for every red word. */}
      <section className="mt-3 rounded-card border border-[#FBE4E2] bg-[#FFF6F5] p-4">
        <h2 className="text-[13px] font-semibold text-brand-ink">
          {t("noteTitle")}
        </h2>
        <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-soft">
          {t("note")}
        </p>
      </section>
    </AppShell>
  );
}
