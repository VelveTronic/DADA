/**
 * The class vocabulary the whole portal is built from — the card and the
 * controls that sit on it. Every page shares these strings so the look cannot
 * drift page by page, and every colour resolves through the tokens in
 * `globals.css`: change the palette there, not here.
 *
 * Two deliberate exceptions, both of which would be noise as tokens. The
 * stepper's `+` carries a brand-tinted drop shadow — `rgba(224,35,28,.45)`,
 * `--color-brand` at 45% — which is one shadow on one control, not a palette
 * entry. And the seven status chips have their own one-off pairs; those live
 * with the chip in `order-status-badge.tsx`, because they are a per-STATE map
 * rather than shared vocabulary.
 *
 * Deliberately a plain module with NO imports: `login-form.tsx` is a client
 * component, and anything it pulls in that reaches `next/headers` (as
 * `app-shell.tsx` does, for the cart count) fails the build.
 */

/**
 * Solid white on the beige ground, a hairline border, at the one card radius.
 *
 * It was `GLASS_CARD` — white at 72% under a 14px backdrop blur — and both
 * halves of that went with the warm-beige design: the fill is opaque now, and a
 * `backdrop-filter` behind an opaque fill blurs nothing at all while still
 * making the element a containing block for `fixed` descendants (see the note in
 * `staff-sidebar.tsx` about the drawer that cost us). Add the padding at the
 * call site; a table card and a text card want different amounts.
 */
export const CARD = "rounded-card border border-border bg-surface";

/**
 * Text/number/date inputs and textareas. The field is a shade OFF the card it
 * sits on rather than the same white — an input the customer cannot see the
 * edges of is an input they do not fill in — and its border is heavier than a
 * card's hairline for the same reason. Both shades are the `field` token pair.
 */
export const FIELD =
  "rounded-[10px] border border-field-border bg-field px-3 py-2 text-ink placeholder:text-faint focus:border-brand focus:outline-none";

/** The same field at row scale, for the inputs that sit inside a list line. */
export const FIELD_SM =
  "rounded-[10px] border border-field-border bg-field px-2 py-1 text-sm text-ink placeholder:text-faint focus:border-brand focus:outline-none";

/**
 * The one accent: brand red, white text. Every screen's main action. Hover
 * darkens to `brand-ink` — the same second shade the red WORDING uses — rather
 * than fading the fill, which on a warm ground reads as disabled.
 */
export const BTN_PRIMARY =
  "rounded-[10px] bg-brand px-4 py-2 font-semibold text-white transition-colors hover:bg-brand-ink disabled:cursor-not-allowed disabled:opacity-40";

/**
 * The small quiet control that sits inside a row — a per-line update, a
 * per-product toggle. Not the main action on its screen, so it holds the accent
 * back until it is hovered.
 */
export const BTN_QUIET =
  "rounded-lg border border-border-strong bg-surface px-2 py-1 text-xs transition-colors hover:border-brand hover:text-brand-ink";

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
 * The `− n +` stepper: TWO detached 32px squares with the figure between them,
 * not one bordered capsule. The design gives the `+` the accent outright — it is
 * the press the catalogue exists for — and leaves `−` a quiet outlined square,
 * so the two are told apart by weight before they are read.
 *
 * The wrapper holds the lone `+` of an empty row just as it holds all three once
 * there is a quantity — same wrapper, more inside it — which is what lets the
 * `+` keep focus across the 0→1 change. The 32px squares are the row's touch
 * targets, so they are sized here and not left to the glyph.
 *
 * Widest state: 32 + 2 + 28 + 2 + 32 = 96px, which is exactly the `6rem` track
 * `product-row.tsx` reserves for it.
 */
export const STEPPER_WRAP = "inline-flex items-center gap-0.5";

export const STEPPER_DEC =
  "inline-flex size-8 items-center justify-center rounded-lg border border-border-strong bg-surface text-[17px] leading-none text-ink-soft transition-colors hover:border-brand hover:text-brand-ink";

export const STEPPER_INC =
  "inline-flex size-8 items-center justify-center rounded-lg bg-brand text-[17px] leading-none text-white shadow-[0_2px_6px_-1px_rgba(224,35,28,.45)] transition-colors hover:bg-brand-ink disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-brand";

/**
 * The figure between them. Between 24px (`min-w-6`) and 28px wide, and that
 * CEILING is what the catalogue row's fixed action column is sized against: the
 * stepper can never grow past 96px, so no quantity — 9999 is the cookie's cap,
 * and a weighed line can carry decimals typed on the cart page — can make it
 * overhang its track and reach back over the product name.
 *
 * MEASURED in the browser, a tabular Archivo digit at 15px/600 advances 8.69px.
 * So one, two and THREE digits all sit inside this box — 8.69, 17.38 and
 * 26.06px against 28px — and it is four (34.75px) that is ellipsised. The box
 * was the mockup's own 26px, which three digits overflowed by 0.06px and turned
 * a plausible order of 120 cajas into `12…`; `max-w-7` is the next native
 * Tailwind step up and buys the whole three-digit range for two pixels.
 *
 * Nothing is lost when it does abbreviate. The number is the full text of the
 * `aria-live` span this class is on, so a screen reader announces the exact
 * quantity; the cart cookie stores it exactly; and the cart page — where a
 * four-figure order line is actually read and edited — has room to show it.
 * This catalogue box is the one place a figure is shortened, and it is
 * shortened because the pixels it would take back come straight off the product
 * name (see the width arithmetic on `ROW` in `product-row.tsx`).
 */
export const STEPPER_QTY =
  "min-w-6 max-w-7 truncate text-center font-num text-[15px] font-semibold tabular-nums";
