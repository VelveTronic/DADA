"use client";

import { useState } from "react";
import { FIELD } from "@/components/ui";

/**
 * A password field with the eye toggle beside it — the one control every
 * password entry in the portal uses (login today; the account-creation forms
 * next). Customers type these on a phone, in a language whose keyboard gives no
 * preview of the last character, so masking with no way back is what produces
 * the "wrong password" the account is then locked out over.
 *
 * The field stays an ordinary uncontrolled `<input name>`: the value lives only
 * in the DOM, goes straight into the server action's FormData, and is never
 * read into state, a prop, a log line or an error. All this component owns is
 * the boolean of whether the browser masks it.
 *
 * The wrapper is `relative` and the input carries `pr-10` so the absolutely
 * positioned button sits INSIDE the field rather than beside it — the label
 * blocks around it are flex columns, and a sibling button would stretch the row
 * and break the shared FIELD geometry.
 */
export function PasswordInput({
  name,
  autoComplete,
  labels,
  required,
  minLength,
}: {
  name: string;
  /** `current-password` on login, `new-password` on a create form. */
  autoComplete: string;
  /** Already localized by the server page — this leaf does no translation. */
  labels: { show: string; hide: string };
  required?: boolean;
  minLength?: number;
}) {
  const [visible, setVisible] = useState(false);

  return (
    <span className="relative block">
      <input
        name={name}
        type={visible ? "text" : "password"}
        required={required}
        minLength={minLength}
        autoComplete={autoComplete}
        className={`${FIELD} w-full pr-10`}
      />
      {/* `type="button"`, or this eye submits the form on every press — it sits
          inside the same <form> as the login button, and a button with no type
          defaults to submit. It comes after the input in DOM order, so the tab
          path stays email → password → eye → 登录. */}
      <button
        type="button"
        aria-label={visible ? labels.hide : labels.show}
        aria-pressed={visible}
        onClick={() => setVisible((v) => !v)}
        className="absolute inset-y-0 right-0 flex w-10 items-center justify-center rounded-r-lg text-muted transition-colors hover:text-brand-ink focus-visible:text-brand-ink"
      >
        {visible ? <EyeOffIcon /> : <EyeIcon />}
      </button>
    </span>
  );
}

/**
 * Inline SVG, not an icon package: the repo ships no icon dependency and two
 * glyphs are not worth one. `aria-hidden` because the button's aria-label
 * already says what the press does — the icon would otherwise be announced
 * twice.
 */
const ICON_PROPS = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  className: "size-5",
  "aria-hidden": true,
} as const;

/** Masked state: an open eye, offering to reveal. */
function EyeIcon() {
  return (
    <svg {...ICON_PROPS}>
      <path d="M2.5 12c2.4-4.1 5.6-6.2 9.5-6.2s7.1 2.1 9.5 6.2c-2.4 4.1-5.6 6.2-9.5 6.2S4.9 16.1 2.5 12Z" />
      <circle cx="12" cy="12" r="2.8" />
    </svg>
  );
}

/** Revealed state: the same eye struck through, offering to mask again. */
function EyeOffIcon() {
  return (
    <svg {...ICON_PROPS}>
      <path d="M2.5 12c2.4-4.1 5.6-6.2 9.5-6.2s7.1 2.1 9.5 6.2c-2.4 4.1-5.6 6.2-9.5 6.2S4.9 16.1 2.5 12Z" />
      <circle cx="12" cy="12" r="2.8" />
      <path d="m4 4 16 16" />
    </svg>
  );
}
