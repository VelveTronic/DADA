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
