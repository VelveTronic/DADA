"use client";

import { useTranslations } from "next-intl";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { signOut } from "@/app/actions/auth";
import { UserIcon } from "@/components/icons";
import { GLASS_CARD, ICON_BTN, ICON_BTN_ACTIVE } from "@/components/ui";

/**
 * The header's 用户 button and the panel it opens: 我的订单, 我的配送地址,
 * 我的信息, and the way out.
 *
 * Hand-rolled, with no headless-ui and no new dependency — four links and a
 * submit button do not justify one. What that costs is the keyboard contract,
 * which is written out here rather than inherited:
 *
 * - the trigger carries `aria-haspopup="menu"` and `aria-expanded`, and the
 *   panel is a real `role="menu"` of `role="menuitem"`s, so the pair announces
 *   itself as the widget it looks like;
 * - ↓/↑ move between items and wrap, Home/End jump to the ends;
 * - opening from the KEYBOARD lands focus on the first item (a mouse press must
 *   not, or the click would be followed by a focus ring nobody asked for) —
 *   `event.detail === 0` is how a click synthesised from Enter or Space is told
 *   apart from a real one;
 * - **Escape closes and returns focus to the trigger**, which is the half people
 *   skip: without it the keyboard user is left focused on a panel that no longer
 *   exists, and the next Tab starts again from the top of the document;
 * - Tab closes the menu and lets focus move on naturally — watched as focus
 *   LEAVING the panel rather than as the keypress, see `onPanelFocusOut`;
 * - a press ANYWHERE else closes it without stealing focus — that press was
 *   already on its way somewhere deliberate.
 *
 * Following a link also closes it: the shell re-renders on navigation but this
 * client component keeps its position in the tree, so its state survives — an
 * open panel would otherwise be sitting over the page it just navigated to.
 *
 * `pointerdown`, not `click`, for the outside press: a `click` listener fires
 * after the mouse-up, which on a control INSIDE the panel is a frame too late to
 * matter and on one outside it is a frame after the page has already moved.
 */
export function UserMenu({
  locale,
  userName,
  /** True while the customer is on one of the three pages this menu leads to. */
  active,
}: {
  locale: string;
  userName: string;
  active: boolean;
}) {
  const [open, setOpen] = useState(false);
  /** Set only when the press that opened the panel came from the keyboard. */
  const [fromKeyboard, setFromKeyboard] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const t = useTranslations("nav");
  const tc = useTranslations("common");

  /** The items, read from the DOM so the list cannot drift from what is rendered. */
  const items = useCallback(
    () =>
      Array.from(
        panelRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [],
      ),
    [],
  );

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    setFromKeyboard(false);
    if (returnFocus) triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (
        panelRef.current?.contains(target) ||
        triggerRef.current?.contains(target)
      ) {
        return;
      }
      close(false);
    };
    // On the document rather than on the panel: Escape has to work from the
    // trigger too, and that is where focus sits after a mouse press.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close(true);
      }
    };

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, close]);

  // Only when the panel was opened by keyboard; a mouse user keeps their cursor.
  useEffect(() => {
    if (open && fromKeyboard) items()[0]?.focus();
  }, [open, fromKeyboard, items]);

  const move = (event: React.KeyboardEvent, step: number | "first" | "last") => {
    const list = items();
    if (list.length === 0) return;
    event.preventDefault();
    const at = list.indexOf(document.activeElement as HTMLElement);
    const next =
      step === "first"
        ? 0
        : step === "last"
          ? list.length - 1
          : at < 0
            ? // Focus is inside the panel but not on an item. ↓ should mean the
              // first and ↑ the last; the modulo below would answer neither.
              step > 0
              ? 0
              : list.length - 1
            : // Wraps both ways, which is what a menu of four is expected to do.
              (at + step + list.length) % list.length;
    list[next]?.focus();
  };

  const onPanelKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown") move(event, 1);
    else if (event.key === "ArrowUp") move(event, -1);
    else if (event.key === "Home") move(event, "first");
    else if (event.key === "End") move(event, "last");
  };

  /**
   * Tab out of the panel, seen from the other side.
   *
   * Closing on the Tab KEYDOWN — which is what this used to do — races the
   * browser: the panel is unmounted while the default action that moves focus is
   * still pending, so focus lands on nothing and the next Tab starts again from
   * the top of the document. Watching focus LEAVE instead means the browser has
   * already chosen where it is going; `relatedTarget` is that element, and it is
   * the whole test — focus moving between two items, or back to the trigger, is
   * not a Tab out.
   *
   * The close is still deferred a microtask so React unmounts after the focus
   * change has settled rather than in the middle of dispatching it.
   *
   * A null `relatedTarget` — alt-tabbing away from the window, or a press on the
   * panel's own dead space, which focuses nothing — closes too, deliberately: for
   * a menu, close-on-doubt is the safe default, and both cases leave a panel
   * nobody is looking at hanging over the page.
   */
  const onPanelFocusOut = (event: React.FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget as Node | null;
    if (
      next &&
      (panelRef.current?.contains(next) || triggerRef.current?.contains(next))
    ) {
      return;
    }
    queueMicrotask(() => close(false));
  };

  const entries = [
    { href: `/${locale}/pedidos`, label: t("orders") },
    { href: `/${locale}/direcciones`, label: t("addresses") },
    { href: `/${locale}/perfil`, label: t("profile") },
  ];

  const ITEM =
    "flex min-h-11 items-center rounded-lg px-3 text-sm text-ink transition-colors hover:bg-brand-soft hover:text-brand-ink focus-visible:bg-brand-soft focus-visible:text-brand-ink focus-visible:outline-none";

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-label={t("account")}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(event) => {
          const next = !open;
          setOpen(next);
          setFromKeyboard(next && event.detail === 0);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" && !open) {
            event.preventDefault();
            setOpen(true);
            setFromKeyboard(true);
          }
        }}
        className={active || open ? ICON_BTN_ACTIVE : ICON_BTN}
      >
        <UserIcon />
      </button>

      {open && (
        <div
          ref={panelRef}
          role="menu"
          aria-label={t("account")}
          onKeyDown={onPanelKeyDown}
          // React's onBlur IS focusout: it bubbles, so one handler on the panel
          // sees every item's turn to lose focus.
          onBlur={onPanelFocusOut}
          // Right-aligned and narrower than a phone: the trigger is the last
          // control in the row, so a left-aligned panel would hang off-screen.
          className={`${GLASS_CARD} absolute right-0 top-full z-50 mt-2 w-56 p-1 shadow-lg`}
        >
          {/* Whose account this is. Not a menuitem — there is nothing to press —
              and therefore `role="presentation"`: a `menu` may only own menu
              items, and an anonymous `<p>` among them makes the whole widget
              invalid (aria-required-children). Presentational strips the
              paragraph's own semantics while leaving its text where a screen
              reader still reaches it. */}
          <p role="presentation" className="truncate px-3 py-2 text-xs text-muted">
            {userName}
          </p>

          {entries.map((entry) => (
            <Link
              key={entry.href}
              role="menuitem"
              href={entry.href}
              onClick={() => close(false)}
              className={ITEM}
            >
              {entry.label}
            </Link>
          ))}

          <div aria-hidden="true" className="my-1 border-t border-border" />

          {/* The same server action and the same hidden locale field the header
              has always posted — moved, not reimplemented. */}
          <form action={signOut}>
            <input type="hidden" name="locale" value={locale} />
            <button
              type="submit"
              role="menuitem"
              className={`${ITEM} w-full text-left`}
            >
              {tc("logout")}
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
