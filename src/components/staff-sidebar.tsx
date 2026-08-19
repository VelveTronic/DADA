"use client";

import { useTranslations } from "next-intl";
import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { signOut } from "@/app/actions/auth";
import {
  BoxIcon,
  ClipboardIcon,
  CloseIcon,
  GridIcon,
  HomeIcon,
  LogoutIcon,
  MenuIcon,
  SlidersIcon,
  UsersIcon,
} from "@/components/icons";
import { ICON_BTN } from "@/components/ui";
import { usePathname } from "@/i18n/navigation";

/**
 * The six destinations of the back office. A KEY rather than a `{href,label}`
 * pair, because everything else about an entry — where it goes, what it is
 * called, which glyph it wears — is the same on every page and belongs here
 * once. The shell decides only WHICH keys this staff member may see.
 */
export type StaffNavKey =
  | "home"
  | "orders"
  | "products"
  | "categories"
  | "users"
  | "settings";

/** Locale-less, exactly as `usePathname` reports it. */
const NAV_PATH: Record<StaffNavKey, string> = {
  home: "/staff",
  orders: "/staff/pedidos",
  products: "/staff/productos",
  categories: "/staff/categorias",
  users: "/staff/usuarios",
  settings: "/staff/ajustes",
};

const NAV_ICON: Record<StaffNavKey, () => React.ReactElement> = {
  home: HomeIcon,
  orders: ClipboardIcon,
  products: BoxIcon,
  categories: GridIcon,
  users: UsersIcon,
  settings: SlidersIcon,
};

/**
 * The back office's own backlog, counted by the shell on every staff page.
 *
 * `null` is not zero. It means the count did not come back — the query errored
 * — and the sidebar draws an em dash for it. A failed read that prints `0`
 * tells a staff member there is nothing to confirm, which is the one lie this
 * block must never tell.
 */
export type ShellCounts = {
  /** Orders waiting to be confirmed (`status = 'submitted'`). */
  submitted: number | null;
  /** Orders the bridge could not inject (`status = 'bridge_failed'`). */
  bridgeFailed: number | null;
  /** Products currently paused (`is_available = false`). */
  unavailable: number | null;
};

/** Whose sidebar this is, drawn at the bottom of it above the way out. */
type Identity = {
  name: string;
  /** The role in words (超级管理员), or the raw column when it is not one we know. */
  roleLabel: string | null;
};

type SidebarProps = Identity & {
  locale: string;
  /** Role-gated by the shell; order is the order they are drawn in. */
  items: StaffNavKey[];
  /** Read by the shell, per request. See `ShellCounts` for what `null` means. */
  counts: ShellCounts;
};

/**
 * One row of the sidebar, in its two states.
 *
 * The colour is named once per state rather than appended to a shared string:
 * `text-ink` and `text-brand-ink` are both bare one-class selectors, so which of
 * them wins is decided by the order Tailwind emitted them in and not by the
 * order they are written here — an "active" row built as `${ROW} text-brand-ink`
 * comes out tinted but ink-coloured. See `ICON_BTN` in `ui.ts`, which had
 * exactly this bug.
 *
 * The HEIGHT is not in here, because the two places this row is drawn want
 * different ones: 38px on the rail and on the desktop sidebar (the mockup's
 * admin row), 44px minimum inside the drawer, which is the phone's whole
 * navigation and holds to the 44px touch target the rest of the phone UI does.
 * `SidebarBody` picks from `collapsible`.
 *
 * `[&_svg]:size-[18px]` is how the glyphs come down from the icon module's own
 * 24px to the mockup's 18px: it compiles to `.row svg`, a (0,1,1) selector, and
 * beats the `.size-6` (0,1,0) that `ICON_PROPS` puts on every icon. Done here
 * rather than in `icons.tsx` on purpose — the storefront header draws the same
 * glyphs at 24px and must not change size because the admin did.
 */
const ROW_BASE =
  "flex items-center gap-2.5 rounded-lg px-3 text-[13.5px] transition-colors hover:bg-brand-soft hover:text-brand-ink focus-visible:bg-brand-soft focus-visible:text-brand-ink focus-visible:outline-none [&_svg]:size-[18px]";
const ROW = `${ROW_BASE} text-ink`;
const ROW_ACTIVE = `${ROW_BASE} bg-brand-soft font-bold text-brand-ink`;

/**
 * Sized by CSS in its own square; the width/height pair is only the intrinsic
 * ratio. Same mark, same trick as the storefront header.
 *
 * The mockup draws the brand row's disc as a div — a red circle with a 東 typed
 * into it, which is the real mark redrawn in CSS. This is the file, at the same
 * 28px, so the sidebar and the storefront header wear one logo and not two.
 */
function Mark() {
  return (
    <Image
      src="/brand/dada-logo.png"
      alt=""
      width={512}
      height={512}
      sizes="28px"
      className="h-7 w-7 shrink-0"
    />
  );
}

/** A backlog figure, or the em dash a failed read gets — see `ShellCounts`. */
function figure(count: number | null): string {
  return count === null ? "—" : String(count);
}

/**
 * The sidebar's contents, drawn identically into the desktop rail and into the
 * phone's drawer.
 *
 * `collapsible` is the ONE difference between the two: on the desktop aside the
 * labels are hidden below `lg` (`sr-only`, never `hidden` — a rail of unlabelled
 * icons would be a rail of anonymous links to a screen reader), and inside the
 * drawer, which is only ever the full width of a phone, they are simply drawn.
 *
 * Everything that is neither a label nor a control — the 商家 chip, the orders
 * badge, the backlog block, the user card — is `hidden` outright on the rail
 * rather than made `sr-only`. A 64px column has nowhere to put a chip or a
 * two-line card, and none of it is unreachable: the full sidebar from `lg` and
 * the drawer below `sm` both draw the lot.
 */
function SidebarBody({
  locale,
  items,
  name,
  roleLabel,
  counts,
  collapsible,
  onNavigate,
}: SidebarProps & {
  collapsible: boolean;
  /** The drawer closes itself when a row is followed; the rail has nothing to close. */
  onNavigate?: () => void;
}) {
  const t = useTranslations("staff");
  const tc = useTranslations("common");
  const pathname = usePathname();

  // `home` is a prefix of every other path, so it is the one entry that has to
  // match exactly; the rest light up for their sub-pages too, which is what the
  // pager and the `?estado=` tabs are.
  const isActive = (key: StaffNavKey) =>
    key === "home" ? pathname === "/staff" : pathname.startsWith(NAV_PATH[key]);

  /** Visually gone on the rail, still the control's accessible name. */
  const label = collapsible ? "sr-only lg:not-sr-only" : undefined;
  /** Ornament and figures: no room for them in a 64px column. */
  const wide = collapsible ? "hidden lg:block" : "";
  /** The row height, per the note on `ROW_BASE`. */
  const height = collapsible ? "h-[38px]" : "min-h-11";

  return (
    <>
      {/* `#EDE9E5` is NOT a token: it is the mockup's hairline for the BACK
          OFFICE only, a shade darker than the customer card's `--color-border`
          (#f2eeea), and promoting it would put a second "border" in the palette
          that no customer screen may use. Same call, same shade, same reason as
          `staff/categorias/page.tsx:55`. 48px of row inside 8px of padding is
          the mockup's 64px brand header. */}
      <div className="border-b border-[#EDE9E5] p-2">
        <Link
          href={`/${locale}/staff`}
          onClick={onNavigate}
          className={`${ROW} h-12 ${collapsible ? "justify-center lg:justify-start" : ""}`}
        >
          <Mark />
          {/* The wordmark, not `staff.title`: DADA is the brand and is written
              the same in both locales, so it is text and not a message key.
              `font-num` is Archivo — the mockup's own face for it. */}
          <span className={`font-num text-lg font-bold tracking-tight ${label ?? ""}`}>
            DADA
          </span>
          <span
            className={`rounded border border-border-strong px-1 py-0.5 text-[10.5px] leading-none font-normal text-muted ${wide}`}
          >
            {t("shell.badge")}
          </span>
        </Link>
      </div>

      {/* The scroller holds the nav AND the backlog block; the `navigation`
          landmark stays tight around the list of links, because a landmark that
          also contains three read-only figures is a landmark that lies about
          how many links it has. */}
      <div className="flex-1 overflow-y-auto p-2">
        <nav aria-label={t("shell.nav")}>
          <ul className="space-y-0.5">
            {items.map((key) => {
              const Icon = NAV_ICON[key];
              const active = isActive(key);
              // The badge counts exactly the orders the 待确认 tab of the queue
              // lists. `null` (the read failed) and 0 both draw nothing: a
              // badge is an alarm, and neither "none" nor "unknown" is one.
              const badgeCount =
                key === "orders" &&
                counts.submitted !== null &&
                counts.submitted > 0
                  ? counts.submitted
                  : null;
              return (
                <li key={key}>
                  <Link
                    href={`/${locale}${NAV_PATH[key]}`}
                    // The one thing the highlight cannot say out loud. Set from the
                    // same boolean, so the colour and the announcement cannot drift.
                    aria-current={active ? "page" : undefined}
                    // The badge is decoration (`aria-hidden` below), so the
                    // count is said in WORDS here instead — and only while it
                    // shows. Without a badge the visible label is already the
                    // whole name. Same contract as the cart tab.
                    aria-label={
                      badgeCount === null
                        ? undefined
                        : t("shell.ordersWithCount", { n: badgeCount })
                    }
                    onClick={onNavigate}
                    className={`${active ? ROW_ACTIVE : ROW} ${height} ${
                      collapsible ? "justify-center lg:justify-start" : ""
                    }`}
                  >
                    <Icon />
                    <span className={label}>{t(`nav.${key}`)}</span>
                    {badgeCount !== null && (
                      <span
                        aria-hidden
                        className={`ml-auto h-5 min-w-5 items-center justify-center rounded-full bg-brand px-[5px] font-num text-[11px] font-bold text-white tabular-nums ${
                          collapsible ? "hidden lg:inline-flex" : "inline-flex"
                        }`}
                      >
                        {badgeCount}
                      </span>
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        <div className={`mx-2 my-3 h-px bg-[#EDE9E5] ${wide}`} />

        {/* 待办, and NOT the mockup's 今日: these three are the whole backlog —
            every order still waiting to be confirmed, every one the bridge could
            not inject, every paused product — with no date filter on any of
            them. A three-day-old submitted order under a "today" heading would
            be a number that means something else than the word above it. The
            genuinely today-scoped figures are the dashboard's KPI strip. */}
        <section aria-label={t("shell.backlog")} className={wide}>
          <h2 className="px-3 pb-2 text-[11px] font-semibold tracking-wide text-muted">
            {t("shell.backlog")}
          </h2>
          {/* `space-y-2` is 8px between rows where the mockup draws 9px — the
              scale's step, one pixel off a number that was never meaningful. */}
          <ul className="space-y-2">
            <li className="flex items-center justify-between px-3 text-xs">
              {/* The queue's own words for the same two sets, borrowed by
                  reference: these rows count exactly what those tabs list, so
                  single-sourcing the labels is what keeps them saying it. */}
              <span className="text-ink">{t("tabSubmitted")}</span>
              <span className="font-num font-semibold tabular-nums">
                {figure(counts.submitted)}
              </span>
            </li>
            <li className="flex items-center justify-between px-3 text-xs">
              <span className="text-ink">{t("tabBridgeFailed")}</span>
              <span
                className={`font-num font-semibold tabular-nums ${
                  counts.bridgeFailed !== null && counts.bridgeFailed > 0
                    ? "text-brand-ink"
                    : ""
                }`}
              >
                {figure(counts.bridgeFailed)}
              </span>
            </li>
            <li className="flex items-center justify-between px-3 text-xs">
              <span className="text-ink">{t("shell.backlogUnavailable")}</span>
              <span className="font-num font-semibold tabular-nums">
                {figure(counts.unavailable)}
              </span>
            </li>
          </ul>
        </section>
      </div>

      <div className="border-t border-[#EDE9E5] p-2">
        {/* Who is signed in. Hidden outright on the rail rather than made
            sr-only: it is a caption, not a control, and an icon-wide column has
            nowhere to put two lines of it. The drawer and the full sidebar both
            show it, so it is never unreachable. The mockup ends this row with a
            ⌄ that opens an account menu; there is no such menu — the one thing
            it would hold is the 退出登录 already sitting below. */}
        <div
          className={`flex items-center gap-2.5 px-3 pb-2 ${
            collapsible ? "hidden lg:flex" : ""
          }`}
        >
          {/* Decorative: the letter is the first character of the name printed
              beside it, so a screen reader saying it twice adds nothing. A blank
              name leaves the disc empty rather than substituting a letter that
              would stand for nobody. */}
          <span
            aria-hidden
            className="inline-flex size-[30px] shrink-0 items-center justify-center rounded-full bg-surface-dim text-xs font-semibold text-ink"
          >
            {name.trim().charAt(0)}
          </span>
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-[12.5px] font-semibold">{name}</span>
            {roleLabel && (
              <span className="truncate text-[11px] text-muted">{roleLabel}</span>
            )}
          </span>
        </div>

        <form action={signOut}>
          <input type="hidden" name="locale" value={locale} />
          <button
            type="submit"
            className={`${ROW} ${height} w-full ${
              collapsible ? "justify-center lg:justify-start" : ""
            }`}
          >
            <LogoutIcon />
            <span className={label}>{tc("logout")}</span>
          </button>
        </form>
      </div>
    </>
  );
}

/**
 * The back office's fixed left column — Medusa's admin shape in DADA's white.
 *
 * Three widths, one component:
 * - below `sm` it is not drawn at all and `StaffTopBar` below carries the same
 *   list into a drawer;
 * - from `sm` it is a 64px rail of icons, which is what keeps a tablet's landing
 *   page a page rather than a menu;
 * - from `lg` the labels come back and it is the 240px sidebar proper. The
 *   mockup's column is 236px; `w-60` is 240 and stays on Tailwind's scale,
 *   because four pixels of a fixed column are worth less than an arbitrary
 *   width nobody can read off a class name.
 *
 * `bg-field` IS the mockup's #FBFAF9 — the same value the token already carries,
 * so the sidebar's wash needed no one-off; only its hairline did.
 *
 * `sticky top-0 h-screen self-start` and not `fixed`: the page keeps ONE
 * scrollbar (the document's), which is what the phone's URL bar and every
 * `scroll-margin` in the pages below already assume. `self-start` is the half
 * people miss — a stretched flex item is as tall as the content beside it, and a
 * sticky element as tall as its container never sticks to anything.
 */
export function StaffSidebar(props: SidebarProps) {
  return (
    <aside className="sticky top-0 hidden h-screen w-16 shrink-0 flex-col self-start border-r border-[#EDE9E5] bg-field sm:flex lg:w-60">
      <SidebarBody {...props} collapsible />
    </aside>
  );
}

/**
 * The phone's slim bar and the drawer behind its hamburger.
 *
 * The keyboard contract, written out rather than inherited from a dialog
 * library the repo does not ship:
 *
 * - the trigger carries `aria-expanded` and, while the panel exists, the
 *   `aria-controls` that points at it (dangling when closed would point at
 *   nothing);
 * - opening moves focus to the drawer's own close button, so the next Tab is
 *   inside the drawer rather than back at the top of the page;
 * - **Escape closes and returns focus to the hamburger** — without it a keyboard
 *   user is left focused on a panel that no longer exists;
 * - focus is NOT trapped, and the panel is therefore not `aria-modal`: claiming
 *   modality while Tab can walk out of it is worse than not claiming it;
 * - following a row closes the drawer, because this component keeps its place in
 *   the tree across a navigation and would otherwise sit over the page it just
 *   opened;
 * - a press on the backdrop closes without stealing focus.
 */
export function StaffTopBar(props: SidebarProps) {
  const { locale } = props;
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const t = useTranslations("staff");

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close(true);
      }
    };
    // The whole bar is `display:none` from `sm` up. A drawer left open across
    // that boundary would take the focused control out of the page with it, and
    // the keyboard would start again from the top of the document.
    const wide = window.matchMedia("(min-width: 40rem)");
    const onWide = () => {
      if (wide.matches) close(false);
    };

    document.addEventListener("keydown", onKeyDown);
    wide.addEventListener("change", onWide);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      wide.removeEventListener("change", onWide);
    };
  }, [open, close]);

  return (
    <>
      <div className="sticky top-0 z-40 border-b border-border bg-surface sm:hidden">
        <div className="flex items-center gap-1 px-2 py-1">
          <button
            ref={triggerRef}
            type="button"
            aria-label={open ? t("shell.closeMenu") : t("shell.openMenu")}
            aria-expanded={open}
            aria-controls={open ? "staff-drawer" : undefined}
            onClick={() => setOpen(!open)}
            className={ICON_BTN}
          >
            <MenuIcon />
          </button>
          <Link
            href={`/${locale}/staff`}
            className="flex min-w-0 items-center gap-2"
          >
            <Mark />
            <span className="truncate font-semibold tracking-tight">
              {t("title")}
            </span>
          </Link>
        </div>
      </div>

      {/* SIBLINGS of the bar, and that is the whole point of the fragment above.
          `backdrop-filter` on the bar makes it the containing block for any
          `fixed` descendant — the same rule as `transform` — so a drawer nested
          inside it resolved `inset-y-0` against a 52px strip: a 288×52 panel with
          every row folded out of reach, on the one viewport where the drawer IS
          the navigation. The bar no longer carries a `backdrop-filter` (it is
          solid `bg-surface` since the warm-beige palette landed, and blurring
          behind an opaque fill did nothing anyway), so that hazard is currently
          latent rather than live — which is exactly why the drawer STAYS out
          here. Any future filter, transform, `perspective`, `will-change` or
          `contain` on the bar would silently fold the drawer back up, and out
          here the containing block is the viewport because nothing between this
          and the initial containing block does any of those. `sm:hidden` on both
          is belt and braces: the trigger is inside a bar that is already
          `display:none` from `sm` up, and the effect above closes the drawer if
          the viewport crosses that line while it is open. */}
      {open && (
        <>
          {/* Not a button and not in the tab order: Escape and the close control
              are the keyboard's two ways out, and this is the mouse's. */}
          <div
            aria-hidden="true"
            onClick={() => close(false)}
            className="fixed inset-0 z-40 bg-ink/30 sm:hidden"
          />
          <div
            id="staff-drawer"
            role="dialog"
            // Its OWN name, not the nav's: the `navigation` landmark inside it
            // carries `shell.nav`, and a dialog announced with the same words as
            // its only child is a dialog announced twice.
            aria-label={t("shell.drawer")}
            // Opaque, not glass: a translucent panel over a dimmed page samples
            // the dimming and takes the label contrast down with it. `bg-field`
            // is the sidebar's own wash and just as opaque — the drawer IS this
            // sidebar on a phone, so it wears the same paint.
            className="fixed inset-y-0 left-0 z-50 flex w-72 max-w-[85vw] flex-col border-r border-border bg-field shadow-xl sm:hidden"
          >
            <div className="flex justify-end p-2 pb-0">
              <button
                ref={closeRef}
                type="button"
                aria-label={t("shell.closeMenu")}
                onClick={() => close(true)}
                className={ICON_BTN}
              >
                <CloseIcon />
              </button>
            </div>
            <SidebarBody
              {...props}
              collapsible={false}
              onNavigate={() => close(false)}
            />
          </div>
        </>
      )}
    </>
  );
}
