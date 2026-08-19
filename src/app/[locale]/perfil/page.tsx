import type { Locale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import Image from "next/image";
import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { CARD } from "@/components/ui";
import { beginCompanyUser, finishCompanyUser } from "@/lib/auth/guards";
import { perfRun } from "@/lib/perf";
import { isProfileResult, type ProfileResult } from "@/lib/profile";
import { getSetting } from "@/lib/settings";
import { DisplayNameForm, PasswordForm } from "./profile-forms";

export const dynamic = "force-dynamic";

/**
 * 我的信息 — what the portal knows about the person signed in, and the two
 * things they may change about it.
 *
 * Reached from the account hub (`/cuenta`), whose 我的 tab stays lit here
 * (`nav-tabs.ts`) — which is why the title row below carries a chevron BACK to
 * it rather than out. Guarded exactly as the catalogue is: `requireCompanyUser`
 * sends a signed-out visitor to the login page and a deactivated account (or one
 * whose restaurant has been deactivated) to `?error=inactive`. A staff member
 * has no `portal_users` row, so this page is not theirs either.
 *
 * READ-ONLY here: the email (changing the login address is a support job, not a
 * self-service one — it is the identity every order was placed under), the
 * restaurant's name and its ERP customer number, both of which DADA maintains.
 *
 * **Design 07's three cards, minus the two that have no data behind them.** The
 * mockup draws an identity card, two key/value cards (门店资料 and 收货与结算)
 * and a 专属客服 contact card. The store's own facts live on `/direcciones`, no
 * payment-terms column exists anywhere in this schema, and there is no named
 * account manager to print — so this screen keeps the identity card and turns
 * the rest of the space over to the two forms, each in a card of its own under a
 * design-07 section head. The mockup's header 保存 button is deliberately absent
 * with them: nothing on this page saves from the header, and the two forms
 * answer independently.
 *
 * The two forms answer through `?name=` and `?pwd=`, so a rejected password
 * never puts a red banner over the name the customer just saved.
 */
export default async function ProfilePage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: Locale }>;
  searchParams: Promise<{ name?: string; pwd?: string }>;
}) {
  const { locale } = await params;
  const { name: rawName, pwd: rawPwd } = await searchParams;
  setRequestLocale(locale);
  const perf = perfRun(`/${locale}/perfil`);
  const { user, supabase, pendingUser } = await beginCompanyUser(locale);
  const t = await getTranslations("profile");
  // The eye toggle's two labels are the login page's; reused rather than
  // duplicated into a second namespace. The way BACK is the order history's, for
  // the same reason: 返回我的账户 is one string in this portal, and it lives in
  // the namespace that first needed it.
  const tLogin = await getTranslations("login");
  const tOrders = await getTranslations("orders");

  // Both parameters are user-editable, so each is proved to be one of the known
  // codes BEFORE it is used as a message key — a raw value would render as
  // whatever the URL said.
  const rawNameText = rawName ?? "";
  const rawPwdText = rawPwd ?? "";
  const nameResult = isProfileResult(rawNameText) ? rawNameText : null;
  const pwdResult = isProfileResult(rawPwdText) ? rawPwdText : null;

  // This page prices nothing, and no bar over it prices anything either: the
  // demand bar draws on 分类 and 搜索 alone (`cart/cart-bar.tsx`). The switch is
  // read because `AppShell` takes it from every customer page — one contract
  // rather than a prop each page decides whether to honour — so it is threaded
  // through here and nothing downstream of it draws.
  //
  // It used to be read on a line of its own, AFTER the guard had finished: a
  // page whose whole content is already in hand paying a second full round trip
  // for one boolean. It now goes out beside the profile row, which is the rule
  // everywhere else in the portal.
  const [portalUser, showPrices] = await Promise.all([
    finishCompanyUser(pendingUser, locale),
    perf.step("settings", getSetting(supabase, "show_prices")),
  ]);

  // The ERP customer number, read HERE rather than widened into the guard's
  // `companies(...)` join: that select is on the hot path of every customer page
  // and `codcli` is drawn on this one screen. Same trade `/direcciones` makes
  // for its address columns, and the same shape — it is keyed by `company_id`,
  // which is what the profile row above went to fetch, so it cannot join the
  // round trip before it. RLS (`companies_select`) would narrow an authenticated
  // customer to this exact row without the filter; the `.eq` says whose row it
  // wants out loud, and is worth one round trip on a page nobody opens twice a
  // day.
  const { data: company, error } = await perf.step(
    "company",
    supabase
      .from("companies")
      // Enumerated, never `select('*')`: `notes` is internal and column-revoked
      // from authenticated, and a star select fails the WHOLE query with a 403.
      .select("codcli")
      .eq("id", portalUser.company_id)
      .maybeSingle(),
  );
  perf.end();
  if (error) console.error("perfil company query:", error);

  // Nullable in the schema — a restaurant is onboarded in the portal before it
  // is linked to Wingest — and a failed read lands here as null too. Either way
  // the LINE is what disappears, not a placeholder in its place: "客户编号 —"
  // is a customer number that reads as broken rather than as pending.
  const codcli = company?.codcli ?? null;

  const banner = (result: ProfileResult | null) =>
    result && (
      <p
        role={result === "ok" ? "status" : "alert"}
        // `mx-4`, because these cards pad their own rows rather than their box:
        // without it the banner would run edge to edge inside the card and read
        // as a second surface. Everything else about it is untouched.
        className={`mx-4 mt-1 mb-3 rounded-lg px-3 py-2 text-sm ${
          result === "ok"
            ? "bg-green-50 text-green-800"
            : "bg-red-50 text-red-700"
        }`}
      >
        {t(`results.${result}`)}
      </p>
    );

  /**
   * A design-07 section head. `text-faint` is the mockup's own #A8A099 and it is
   * the LICENSED use of that token (`globals.css`): it labels a group whose rows
   * say what they are on their own — an address beside 邮箱, a named input under
   * it — i.e. supplementary text that repeats what the content already shows,
   * exactly like the /cuenta rows' hints. It is never body copy, and it never
   * sits on anything but the white card below.
   */
  const HEAD = "px-4 pt-3 pb-1 text-xs font-semibold text-faint";

  return (
    <AppShell
      locale={locale}
      user={{ name: portalUser.display_name ?? portalUser.companies.name }}
      showPrices={showPrices}
    >
      {/* The screen's title row and its way back UP the hierarchy, the same one
          /pedidos draws: the mockup's white header band, translated into an
          in-flow title row on the page's own ground under the shell's real
          header. The chevron is a 44px target pulled into the page gutter by
          `-ml-2.5` so the mark lines up with the cards below. */}
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

      {/* WHO THIS ACCOUNT IS. The mockup's 56px disc carries a red circle with a
          white 東 in it — which is exactly what the shipped mark already is
          (`/brand/dada-logo.png` is the red sphere), so the disc IS the mark
          rather than a letter drawn on a tinted circle. `bg-brand` under it is
          load-bearing rather than decoration: the PNG's corners are transparent
          and its rim is anti-aliased, so the fill is what keeps a 56px circle
          solid to its edge instead of showing the card's white through the
          feather. Decorative image: the restaurant's name is beside it, and the
          header's own mark already says "DADA" on every page.

          The mockup's 已认证商户 badge is not here — no such state exists on a
          company row, and a badge that is always on is not a badge. */}
      <section className={`${CARD} mt-3 flex items-center gap-3.5 p-4`}>
        <span className="flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-full bg-brand">
          <Image
            src="/brand/dada-logo.png"
            alt=""
            width={512}
            height={512}
            sizes="56px"
            className="size-14"
          />
        </span>
        {/* `min-w-0`: without it a flex child refuses to shrink below its
            content and `truncate` on the name never fires — a long restaurant
            name would push the card wider than the screen instead. */}
        <div className="flex min-w-0 flex-col gap-1">
          <p className="truncate text-[15px] font-bold">
            {portalUser.companies.name}
          </p>
          {codcli !== null && (
            // `font-num` for the figure in it — Archivo, the one webfont, is
            // loaded for numerals — and the CJK/Latin words fall through the
            // stack to the body face as they do on every other `font-num` line.
            // `String(...)`, because a bare number argument would be FORMATTED:
            // ICU renders 10286 as "10.286" in Spanish, and a customer number
            // with a thousands separator in it is not the customer's number.
            <p className="font-num text-[11.5px] text-muted">
              {t("customerNo", { code: String(codcli) })}
            </p>
          )}
        </div>
      </section>

      {/* 账号资料 — the address this account signs in with, and the one name the
          customer may change about themselves. */}
      <section className={`${CARD} mt-3`}>
        <h2 className={HEAD}>{t("sectionAccount")}</h2>

        {banner(nameResult)}

        <div className="flex min-h-[52px] items-center gap-3 border-t border-border px-4 py-3 text-sm">
          <span className="w-[76px] flex-none text-[13px] text-muted">
            {t("email")}
          </span>
          {/* `break-all`: an address is one unbreakable token to a browser, and
              a long one would otherwise widen the card past a phone. */}
          <span className="min-w-0 flex-1 break-all text-right leading-snug">
            {user.email ?? "—"}
          </span>
        </div>
        <p className="px-4 pt-2 text-xs text-muted">{t("emailHint")}</p>

        <DisplayNameForm
          locale={locale}
          displayName={portalUser.display_name ?? ""}
          labels={{
            displayName: t("displayName"),
            displayNameHint: t("displayNameHint"),
            save: t("save"),
          }}
        />
      </section>

      <section className={`${CARD} mt-3`}>
        <h2 className={HEAD}>{t("sectionPassword")}</h2>

        {banner(pwdResult)}

        <PasswordForm
          locale={locale}
          labels={{
            currentPassword: t("currentPassword"),
            newPassword: t("newPassword"),
            confirmPassword: t("confirmPassword"),
            passwordHint: t("passwordHint"),
            changePassword: t("changePassword"),
            showPassword: tLogin("showPassword"),
            hidePassword: tLogin("hidePassword"),
          }}
        />
      </section>
    </AppShell>
  );
}
