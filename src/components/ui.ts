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
 * A shell nav entry, and the logout button that sits beside them.
 *
 * These two live here rather than in `app-shell.tsx` because the cart entry is
 * now a CLIENT leaf (it counts a cart that changes without a navigation) and
 * the shell around it is a Server Component that reads `next/headers` — the one
 * import a client component must never inherit. This module is the shared,
 * import-free vocabulary both halves can hold, which is exactly why it has no
 * imports of its own.
 */
export const NAV_LINK =
  "text-sm text-muted transition-colors hover:text-brand-ink";

/** The same entry once it has something to say — today, a non-empty cart. */
export const NAV_PILL =
  "rounded-full bg-brand-soft px-2.5 py-1 text-sm text-brand-ink transition-colors hover:bg-brand hover:text-white";

/**
 * The `− n +` pill: one bordered glass capsule holding two ghost buttons around
 * a tabular figure, rather than three controls floating in a table cell. Its
 * 32px squares are the row's touch targets, so they are sized here and not left
 * to the icon.
 */
export const STEPPER =
  "inline-flex h-9 items-center rounded-full border border-border bg-white/70";

export const STEPPER_BTN =
  "inline-flex size-8 items-center justify-center rounded-full text-base leading-none transition-colors hover:text-brand-ink disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-ink";
