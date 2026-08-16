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
  HomeIcon,
  LogoutIcon,
  MenuIcon,
  SlidersIcon,
  UsersIcon,
} from "@/components/icons";
import { ICON_BTN } from "@/components/ui";
import { usePathname } from "@/i18n/navigation";

/**
 * The five destinations of the back office. A KEY rather than a `{href,label}`
 * pair, because everything else about an entry — where it goes, what it is
 * called, which glyph it wears — is the same on every page and belongs here
 * once. The shell decides only WHICH keys this staff member may see.
 */
export type StaffNavKey = "home" | "orders" | "products" | "users" | "settings";

/** Locale-less, exactly as `usePathname` reports it. */
const NAV_PATH: Record<StaffNavKey, string> = {
  home: "/staff",
  orders: "/staff/pedidos",
  products: "/staff/productos",
  users: "/staff/usuarios",
  settings: "/staff/ajustes",
};

const NAV_ICON: Record<StaffNavKey, () => React.ReactElement> = {
  home: HomeIcon,
  orders: ClipboardIcon,
  products: BoxIcon,
  users: UsersIcon,
  settings: SlidersIcon,
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
};

/**
 * One 44px row of the sidebar, in its two states.
 *
 * The colour is named once per state rather than appended to a shared string:
 * `text-ink` and `text-brand-ink` are both bare one-class selectors, so which of
 * them wins is decided by the order Tailwind emitted them in and not by the
 * order they are written here — an "active" row built as `${ROW} text-brand-ink`
 * comes out tinted but ink-coloured. See `ICON_BTN` in `ui.ts`, which had
 * exactly this bug.
 */
const ROW_BASE =
  "flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm transition-colors hover:bg-brand-soft hover:text-brand-ink focus-visible:bg-brand-soft focus-visible:text-brand-ink focus-visible:outline-none";
const ROW = `${ROW_BASE} text-ink`;
const ROW_ACTIVE = `${ROW_BASE} bg-brand-soft font-medium text-brand-ink`;

/**
 * Sized by CSS in its own square; the width/height pair is only the intrinsic
 * ratio. Same mark, same trick as the storefront header.
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

/**
 * The sidebar's contents, drawn identically into the desktop rail and into the
 * phone's drawer.
 *
 * `collapsible` is the ONE difference between the two: on the desktop aside the
 * labels are hidden below `lg` (`sr-only`, never `hidden` — a rail of unlabelled
 * icons would be a rail of anonymous links to a screen reader), and inside the
 * drawer, which is only ever the full width of a phone, they are simply drawn.
 */
function SidebarBody({
  locale,
  items,
  name,
  roleLabel,
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

  return (
    <>
      <div className="border-b border-border p-2">
        <Link
          href={`/${locale}/staff`}
          onClick={onNavigate}
          className={`${ROW} font-semibold tracking-tight ${
            collapsible ? "justify-center lg:justify-start" : ""
          }`}
        >
          <Mark />
          <span className={label}>{t("title")}</span>
        </Link>
      </div>

      <nav aria-label={t("shell.nav")} className="flex-1 overflow-y-auto p-2">
        <ul className="space-y-0.5">
          {items.map((key) => {
            const Icon = NAV_ICON[key];
            const active = isActive(key);
            return (
              <li key={key}>
                <Link
                  href={`/${locale}${NAV_PATH[key]}`}
                  // The one thing the highlight cannot say out loud. Set from the
                  // same boolean, so the colour and the announcement cannot drift.
                  aria-current={active ? "page" : undefined}
                  onClick={onNavigate}
                  className={`${active ? ROW_ACTIVE : ROW} ${
                    collapsible ? "justify-center lg:justify-start" : ""
                  }`}
                >
                  <Icon />
                  <span className={label}>{t(`nav.${key}`)}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="border-t border-border p-2">
        {/* Who is signed in. Hidden outright on the rail rather than made
            sr-only: it is a caption, not a control, and an icon-wide column has
            nowhere to put two lines of it. The drawer and the full sidebar both
            show it, so it is never unreachable. */}
        <p
          className={`truncate px-3 pb-1 text-xs text-muted ${
            collapsible ? "hidden lg:block" : ""
          }`}
        >
          {name}
          {roleLabel ? ` · ${roleLabel}` : ""}
        </p>

        <form action={signOut}>
          <input type="hidden" name="locale" value={locale} />
          <button
            type="submit"
            className={`${ROW} w-full ${
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
 * The back office's fixed left column — Medusa's admin shape in DADA's glass.
 *
 * Three widths, one component:
 * - below `sm` it is not drawn at all and `StaffTopBar` below carries the same
 *   list into a drawer;
 * - from `sm` it is a 64px rail of icons, which is what keeps a tablet's landing
 *   page a page rather than a menu;
 * - from `lg` the labels come back and it is the 240px sidebar proper.
 *
 * `sticky top-0 h-screen self-start` and not `fixed`: the page keeps ONE
 * scrollbar (the document's), which is what the phone's URL bar and every
 * `scroll-margin` in the pages below already assume. `self-start` is the half
 * people miss — a stretched flex item is as tall as the content beside it, and a
 * sticky element as tall as its container never sticks to anything.
 */
export function StaffSidebar(props: SidebarProps) {
  return (
    <aside className="sticky top-0 hidden h-screen w-16 shrink-0 flex-col self-start border-r border-border bg-surface backdrop-blur-[14px] sm:flex lg:w-60">
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
      <div className="sticky top-0 z-40 border-b border-border bg-background/85 backdrop-blur-[14px] sm:hidden">
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
          the navigation. Out here the containing block is the viewport again,
          because nothing between this and the initial containing block filters,
          transforms or contains. `sm:hidden` on both is belt and braces: the
          trigger is inside a bar that is already `display:none` from `sm` up, and
          the effect above closes the drawer if the viewport crosses that line
          while it is open. */}
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
            // the dimming and takes the label contrast down with it.
            className="fixed inset-y-0 left-0 z-50 flex w-72 max-w-[85vw] flex-col border-r border-border bg-background shadow-xl sm:hidden"
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
