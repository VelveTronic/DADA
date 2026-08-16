/**
 * The class vocabulary the whole portal is built from — the frosted-glass card
 * and the three controls that sit on it. Seven pages share these strings so the
 * look cannot drift page by page, and every value resolves through the tokens in
 * `globals.css`: change the palette there, not here.
 *
 * Deliberately a plain module with NO imports: `login-form.tsx` is a client
 * component, and anything it pulls in that reaches `next/headers` (as
 * `app-shell.tsx` does, for the cart count) fails the build.
 */

/**
 * White at 72% over the warm-grey ground, a hairline border and a 14px backdrop
 * blur, at the one card radius — the same four properties the sticky header uses.
 * Add the padding at the call site; a table card and a text card want different
 * amounts.
 */
export const GLASS_CARD =
  "rounded-[var(--radius-card)] border border-border bg-surface backdrop-blur-[14px]";

/** Text/number/date inputs and textareas. */
export const FIELD =
  "rounded-lg border border-border bg-white/70 px-3 py-2 text-ink placeholder:text-muted focus:border-brand focus:outline-none";

/** The same field at row scale, for the inputs that sit inside a list line. */
export const FIELD_SM =
  "rounded-lg border border-border bg-white/70 px-2 py-1 text-sm text-ink placeholder:text-muted focus:border-brand focus:outline-none";

/** The one accent: brand red, white text. Every screen's main action. */
export const BTN_PRIMARY =
  "rounded-lg bg-brand px-4 py-2 text-white transition-colors hover:bg-brand/90 disabled:cursor-not-allowed disabled:opacity-40";

/**
 * The small quiet control that sits inside a row — a per-line update, a
 * per-product toggle. Not the main action on its screen, so it holds the accent
 * back until it is hovered.
 */
export const BTN_QUIET =
  "rounded-lg border border-border bg-white/70 px-2 py-1 text-xs transition-colors hover:border-brand hover:text-brand-ink";

/**
 * A quiet shell link: small, muted, brand-ink on hover. Today the staff
 * breadcrumb's root crumb.
 *
 * It lives here rather than in a shell file because both halves of the portal
 * are built from client leaves (the cart entry counts a cart that changes
 * without a navigation) and Server Components that read `next/headers` — the one
 * import a client component must never inherit. This module is the shared,
 * import-free vocabulary both halves can hold, which is exactly why it has no
 * imports of its own.
 */
export const NAV_LINK =
  "text-sm text-muted transition-colors hover:text-brand-ink";

/**
 * A storefront header icon — the shop, the search, the cart and the account
 * menu, whether the control under it is a link or a button.
 *
 * `size-11` is 44px, the touch target Apple and WCAG 2.5.5 both ask for, and it
 * is the reason the box is so much larger than the 24px glyph inside it: on a
 * phone these four sit in a row at the top corner of the screen, thumbed by
 * somebody holding a delivery note in the other hand. `relative` is here for the
 * cart's count badge, which is positioned against this box.
 *
 * The glyph is drawn with `stroke="currentColor"` (see `icons.tsx`), so the
 * colour rules below reach it without the icon knowing anything about state.
 *
 * The resting INK is not in the shared half, and that is load-bearing. Two plain
 * colour utilities on one element (`text-ink text-brand-ink`) are not resolved by
 * the order they are written in — both are one-class selectors, so the winner is
 * whichever Tailwind emitted last, and it was `text-ink`. Appending the accent to
 * the base string therefore produced an "active" control that was tinted but
 * still ink-coloured. Each state names its own colour exactly once instead.
 * (`hover:`/`focus-visible:` are safe either way: a pseudo-class outranks a bare
 * one.)
 */
const ICON_BTN_BASE =
  "relative inline-flex size-11 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-brand-soft hover:text-brand-ink focus-visible:bg-brand-soft focus-visible:text-brand-ink";

export const ICON_BTN = `${ICON_BTN_BASE} text-ink`;

/** The same control on the page it points at: the one accent, held. */
export const ICON_BTN_ACTIVE = `${ICON_BTN_BASE} bg-brand-soft text-brand-ink`;

/**
 * The `− n +` pill: one bordered glass capsule, rather than controls floating
 * loose in a table cell. It holds the lone `+` of an empty row just as it holds
 * all three once there is a quantity — same capsule, more inside it — which is
 * what lets the `+` keep focus across the 0→1 change. Its 32px squares are the
 * row's touch targets, so they are sized here and not left to the glyph.
 */
export const STEPPER =
  "inline-flex h-9 items-center rounded-full border border-border bg-white/70 transition-colors focus-within:border-brand hover:border-brand";

export const STEPPER_BTN =
  "inline-flex size-8 items-center justify-center rounded-full text-base leading-none transition-colors hover:text-brand-ink disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-ink";
