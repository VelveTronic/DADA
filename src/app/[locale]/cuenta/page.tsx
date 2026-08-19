import type { Locale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import Image from "next/image";
import Link from "next/link";
import { signOut } from "@/app/actions/auth";
import { AppShell } from "@/components/app-shell";
import { CARD } from "@/components/ui";
import { beginCompanyUser, finishCompanyUser } from "@/lib/auth/guards";
import { ACTIVE_ORDER_STATUSES, madridMonthStartIso } from "@/lib/orders";
import { perfRun } from "@/lib/perf";
import { getSetting } from "@/lib/settings";

export const dynamic = "force-dynamic";

/**
 * The four row glyphs. They are drawn here rather than in `icons.tsx` because
 * that module is the NAV vocabulary — one 24-unit grid at `size-6`, shared by
 * the storefront header and the staff sidebar — and these are 14px marks that
 * exist only inside this page's 28px tiles. Same contract as those, though:
 * `stroke="currentColor"` so the tile decides the colour, and `aria-hidden`
 * because the row's own text is its name.
 */
const MENU_ICON = {
  viewBox: "0 0 14 14",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  className: "size-3.5",
  "aria-hidden": true,
} as const;

/** 我的订单 — a document's lines, the last one short. */
function OrdersIcon() {
  return (
    <svg {...MENU_ICON}>
      <path d="M2 3.6h10M2 7h10M2 10.4h6" />
    </svg>
  );
}

/** 常购清单 — a diamond: the design's square, stood on its corner. */
function FavoritesIcon() {
  return (
    <svg {...MENU_ICON}>
      <path d="M7 1.7 12.3 7 7 12.3 1.7 7Z" />
    </svg>
  );
}

/** 收货门店与地址 — a map pin's target: a ring around the spot itself. */
function AddressesIcon() {
  return (
    <svg {...MENU_ICON}>
      <circle cx="7" cy="7" r="5.1" />
      <circle cx="7" cy="7" r="1.3" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** 我的信息 — a person: head over shoulders. */
function ProfileIcon() {
  return (
    <svg {...MENU_ICON}>
      <circle cx="7" cy="4.7" r="2.4" />
      <path d="M2.3 12.2a4.7 4.7 0 0 1 9.4 0" />
    </svg>
  );
}

/**
 * 我的 — the account hub: who this restaurant is, three figures about its
 * orders, and the four places the rest of the portal lives.
 *
 * It is the fourth tab of the phone's bottom bar (`tab-bar.tsx`, 我的) and the
 * storefront menu's first entry, and it exists so a customer on a phone has ONE
 * screen that answers "where is everything" — the desktop header's dropdown
 * cannot be that screen, and the pages it leads to are otherwise unreachable by
 * thumb.
 *
 * **The red card is the header.** The design paints the whole top of the phone
 * brand red, status bar included; that is mockup chrome. Here it is an ordinary
 * in-flow card on the beige ground — same radius and same gutter as every other
 * card in the portal — which is the honest translation of it into a page that
 * scrolls under a real header.
 *
 * **The three figures are OURS, not the design's.** The mockup counts 已提交 /
 * 配送中 / 本月下单, i.e. it reports the pipeline state by name. This one counts
 * 进行中 (`ACTIVE_ORDER_STATUSES`) / 已完成 (`albaran`) / 本月下单, because the
 * states between those two are the bridge's business and a restaurant reading
 * "已进ERP" on its account screen has learned something about our plumbing
 * rather than about its order.
 *
 * Guarded exactly as every other customer page: `beginCompanyUser` sends a
 * signed-out visitor to the login page, `finishCompanyUser` sends a deactivated
 * account (or one whose restaurant is deactivated) to `?error=inactive`, and
 * neither the counts nor the name are rendered before it has fired.
 */
export default async function AccountPage({
  params,
}: {
  params: Promise<{ locale: Locale }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const perf = perfRun(`/${locale}/cuenta`);
  const { user, supabase, pendingUser } = await beginCompanyUser(locale);
  const t = await getTranslations("account");
  // The way out is the header menu's, wording included: one 退出登录 in the
  // portal, in the namespace that already holds it.
  const tCommon = await getTranslations("common");

  // ROUND ONE. Nothing on this page can be read before the profile row lands —
  // all four counts are keyed by `company_id` — so the only thing that rides
  // beside the guard is the price switch every customer page pays for anyway.
  const [portalUser, showPrices] = await Promise.all([
    finishCompanyUser(pendingUser, locale),
    perf.step("settings", getSetting(supabase, "show_prices")),
  ]);

  // ROUND TWO. Four counts, all four in flight together, and NOT ONE ROW comes
  // back: `head: true` makes each a HEAD request whose only answer is the
  // Content-Range count, so a restaurant with 900 orders pays the same as one
  // with 9. The select list still has to name a real column the customer may
  // read — `orders` is column-revoked (`staff_note`) and a `*` there 403s the
  // whole query, per CLAUDE.md — so each one names exactly one.
  //
  // Every filter is repeated even though `orders_read` and the favourites policy
  // already narrow both tables to this company: the same belt-and-suspenders the
  // history page uses, and here it is what makes the four queries say out loud
  // which restaurant's figures they are.
  const companyId = portalUser.company_id;
  const [activeResult, doneResult, monthResult, favoritesResult] =
    await Promise.all([
      perf.step(
        "active",
        supabase
          .from("orders")
          .select("id", { count: "exact", head: true })
          .eq("company_id", companyId)
          .in("status", ACTIVE_ORDER_STATUSES),
      ),
      perf.step(
        "done",
        supabase
          .from("orders")
          .select("id", { count: "exact", head: true })
          .eq("company_id", companyId)
          .eq("status", "albaran"),
      ),
      perf.step(
        "month",
        supabase
          .from("orders")
          .select("id", { count: "exact", head: true })
          .eq("company_id", companyId)
          // Madrid's month, not UTC's — see `madridMonthStartIso`. This is the
          // helper's only call site; it is here rather than inlined because the
          // offset arithmetic is what needs the unit test, not the query.
          .gte("created_at", madridMonthStartIso(new Date())),
      ),
      perf.step(
        "favorites",
        supabase
          .from("favorites")
          .select("company_id", { count: "exact", head: true })
          .eq("company_id", companyId),
      ),
    ]);
  perf.end();

  if (activeResult.error) console.error("account active count:", activeResult.error);
  if (doneResult.error) console.error("account done count:", doneResult.error);
  if (monthResult.error) console.error("account month count:", monthResult.error);
  if (favoritesResult.error) {
    console.error("account favorites count:", favoritesResult.error);
  }

  // A count that did not come back is 0 on the screen. Every one of these is a
  // FIGURE, not a page: a failed read must leave the hub standing so the rows
  // under it still lead somewhere.
  const activeCount = activeResult.count ?? 0;
  const doneCount = doneResult.count ?? 0;
  const monthCount = monthResult.count ?? 0;
  const favoriteCount = favoritesResult.count ?? 0;

  // Who is signed in, under the restaurant's name. Two nullable pieces joined
  // rather than interpolated: an account with no display name yet (it is
  // optional) would otherwise read " · pedidos@…", and the separator would be
  // the first thing on the line.
  const identity = [portalUser.display_name, user.email]
    .filter(Boolean)
    .join(" · ");

  const stats = [
    { key: "active", n: activeCount, label: t("statActive") },
    { key: "done", n: doneCount, label: t("statDone") },
    { key: "month", n: monthCount, label: t("statMonth") },
  ];

  const rows = [
    {
      href: `/${locale}/pedidos`,
      label: t("menuOrders"),
      // Only when there IS something running. "0 个进行中" is a sentence about
      // nothing, and the row still leads to the whole history.
      hint: activeCount > 0 ? t("hintActive", { n: activeCount }) : null,
      icon: <OrdersIcon />,
    },
    {
      // The catalogue's favourites TAB, not a page of its own: 常购清单 is a
      // filter over the same product list, and it is where the stars already
      // lead (`catalogo/page.tsx`).
      href: `/${locale}/catalogo?tab=favoritos`,
      label: t("menuFavorites"),
      // Shown at zero too, unlike the orders hint: "0 种" is the answer to "what
      // is on my list", and it is how a customer finds out the list is empty
      // without opening it.
      hint: t("hintKinds", { n: favoriteCount }),
      icon: <FavoritesIcon />,
    },
    {
      href: `/${locale}/direcciones`,
      label: t("menuAddresses"),
      hint: null,
      icon: <AddressesIcon />,
    },
    {
      href: `/${locale}/perfil`,
      label: t("menuProfile"),
      hint: null,
      icon: <ProfileIcon />,
    },
  ];

  return (
    <AppShell
      locale={locale}
      user={{ name: portalUser.display_name ?? portalUser.companies.name }}
      showPrices={showPrices}
    >
      {/* The red card IS the header of this screen, so there is no visible
          title to duplicate it — but the document still needs a top-level name,
          as on `/buscar`. */}
      <h1 className="sr-only">{t("title")}</h1>

      {/* A card by geometry, NOT by `CARD`, and that is measured rather than
          preferred: `CARD` carries `bg-surface`, and appending `bg-brand` to it
          leaves two one-class background utilities on one element, which CSS
          resolves by the order Tailwind emitted them in — alphabetically, so
          `bg-surface` wins and the card renders WHITE. The same trap `ui.ts`
          documents for `text-ink text-brand-ink`, verified here in a browser.
          (`border-transparent` happens to win the same race, and relying on that
          would be relying on the spelling of a token.) So the one red surface in
          the portal names its own three: the shared radius, a transparent border
          that keeps its 1px box aligned with every other card down the page, and
          the fill.

          AA OVER MOCKUP LITERALISM, the call this repo already made on Task
          1's chips and muted text. The design veils this card's small text with
          opacity, and composited over the red all three land under 4.5:1: the
          identity line at 3.45 (`opacity-80` → #F9D3D2), the 编辑 link at 3.74
          (`opacity-85` → #FADEDD), the stat labels at 3.29 (`opacity-85` over a
          `bg-white/15` strip). So the veils come off — those three are plain
          white, 4.74:1 on #E0231C. The strip could not pass that way, because a
          LIGHTER ground makes white text WORSE, so it flips from a white glow
          to a darker well: `bg-black/10`, which rasterises to #C91F19 over the
          red and carries the 11px labels at 5.69:1. Every figure here was
          measured off the rendered pixels, not off the declared colours. What
          the opacity was carrying, size and weight carry instead — the name is
          `text-lg` bold, the identity `text-xs`. */}
      <section className="mt-4 rounded-card border border-transparent bg-brand p-5 text-white">
        <div className="flex items-center gap-3.5">
          {/* The mark on a white disc, which is what a restaurant recognises
              this account by. Decorative: the name beside it is the real label,
              and the header's own mark already says "DADA" on every page. */}
          <span className="flex size-[54px] shrink-0 items-center justify-center rounded-full bg-white">
            <Image
              src="/brand/dada-logo.png"
              alt=""
              width={512}
              height={512}
              sizes="32px"
              className="h-8 w-8"
            />
          </span>

          {/* `min-w-0`: without it a flex child refuses to shrink below its
              content, and `truncate` on the two lines below would never fire —
              the long name would push the 编辑 link off the card instead. */}
          <div className="flex min-w-0 flex-col gap-1">
            <p className="truncate text-lg font-bold">
              {portalUser.companies.name}
            </p>
            {/* Both halves are nullable, so the line is only drawn when there is
                one — an empty `<p>` would still take its 16px under the name. */}
            {identity && <p className="truncate text-xs">{identity}</p>}
          </div>

          {/* 44px of height for the thumb, taken as `min-h-11` rather than a
              fixed box so the row's own alignment still centres it. The chevron
              is decoration, so it is hidden and the word is the whole visible
              label — but 编辑 alone names nothing in a list of links read out
              of context, so the accessible name says what is being edited. It
              composes two strings already on this page rather than adding a
              third to translate: 编辑 · 我的信息 / Editar · Mis datos. */}
          <Link
            href={`/${locale}/perfil`}
            aria-label={`${t("edit")} · ${t("menuProfile")}`}
            className="ml-auto flex min-h-11 shrink-0 items-center pl-3 text-xs"
          >
            {t("edit")}
            <span aria-hidden className="ml-1">
              ›
            </span>
          </Link>
        </div>

        {/* Black at 10% over the red: the strip is still a shade of the card
            it sits on rather than a second surface, but an inset WELL instead
            of a glow — see the AA note above for why that direction. Three
            equal columns, so the figures line up whatever their labels are:
            本月下单 and "Pedidos este mes" are not the same width.

            A description list, because three label/figure pairs are exactly
            that. The valid grouping is `dl > div > dt… dd…`, so the `dt` comes
            FIRST inside its `div` — which is also the order the pair reads in
            ("进行中, 3") — and `flex-col-reverse` puts the figure back on top
            visually without inverting the markup. */}
        <dl className="mt-4 flex rounded-xl bg-black/10 p-3">
          {stats.map((stat) => (
            // Keyed by the stat's own name, not by its label: the label is
            // translated, so a zh/es switch would rewrite every key.
            <div
              key={stat.key}
              className="flex flex-1 flex-col-reverse items-center gap-1"
            >
              <dt className="text-[11px]">{stat.label}</dt>
              {/* `font-num` is Archivo, the one webfont, loaded for exactly
                  this: numerals. `tabular-nums` keeps the three columns from
                  shifting as the figures change. */}
              <dd className="font-num text-xl font-bold tabular-nums">
                {stat.n}
              </dd>
            </div>
          ))}
        </dl>
      </section>

      {/* A second landmark on a page that already has the header's, so it is
          named — and named for ITSELF (账号菜单 / "Menú de la cuenta") rather
          than with `account.title`, which is the h1's string: a landmark list
          reading "我的 / 我的" would be two entries for one page. The links are
          its own children: `divide-y` draws the hairline BETWEEN them, and each
          row is one link edge to edge — a 54px target a thumb cannot miss,
          rather than a label with a link somewhere in it. */}
      <nav
        aria-label={t("menuLabel")}
        className={`${CARD} mt-3 divide-y divide-border`}
      >
        {rows.map((row) => (
          <Link
            key={row.href}
            href={row.href}
            // The hover tint is `surface-dim`, not the `brand-soft` the header
            // menu's items use: the icon tile is already brand-soft, and tinting
            // the row the same colour would swallow it.
            className="flex min-h-[54px] items-center gap-3 px-4 text-sm transition-colors hover:bg-surface-dim"
          >
            <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-brand-soft text-brand-ink">
              {row.icon}
            </span>
            <span className="flex-1 truncate">{row.label}</span>
            {row.hint && (
              <span className="shrink-0 font-num text-xs text-faint tabular-nums">
                {row.hint}
              </span>
            )}
            {/* Not a token: the design's own chevron grey, one shade between
                `faint` and `border-strong`, and it exists only on this row. It
                is decoration — the link already says where it goes. */}
            <span aria-hidden className="shrink-0 text-[#C9C1BA]">
              ›
            </span>
          </Link>
        ))}
      </nav>

      {/* The header menu's sign-out, moved onto the thumb: the same server
          action, the same hidden locale field, the same string. */}
      <form action={signOut} className="mt-3">
        <input type="hidden" name="locale" value={locale} />
        <button
          type="submit"
          className={`${CARD} h-12 w-full text-sm text-muted transition-colors hover:text-brand-ink`}
        >
          {tCommon("logout")}
        </button>
      </form>
    </AppShell>
  );
}
