import { changePassword, updateDisplayName } from "@/app/actions/profile";
import { PasswordInput } from "@/components/password-input";
import { BTN_PRIMARY, FIELD } from "@/components/ui";
import { MAX_NAME_LENGTH, MIN_PASSWORD_LENGTH } from "@/lib/user-admin";

/**
 * The two forms on 我的信息, as Server Components with no state and no
 * JavaScript of their own.
 *
 * `PasswordInput` is a Client Component (it owns the eye toggle's boolean) and
 * is rendered from here perfectly happily: every prop it takes is a string the
 * server already translated. The forms themselves stay server-side because
 * nothing on them needs to survive a submit — a rejected change comes back as
 * `?name=` / `?pwd=` and the fields it would have restored are a name the
 * customer can see in the header and two passwords that must always be retyped.
 *
 * The bounds are IMPORTED, not typed in: `maxLength` and `minLength` here are
 * the browser's copy of the rules `validateDisplayName` and
 * `validatePasswordChange` enforce on the server, and a second literal would be
 * a rule that drifts. The attributes are a courtesy — the server checks again.
 */

/** 显示名称 — the only column a customer may write about themselves. */
export function DisplayNameForm({
  locale,
  displayName,
  labels,
}: {
  locale: string;
  /** The current value, or "" when the row has none and the header falls back. */
  displayName: string;
  labels: { displayName: string; displayNameHint: string; save: string };
}) {
  return (
    // The card this sits in pads its own ROWS rather than its box (design 07's
    // section head and key/value rows run to the card's edge and draw their own
    // rules), so the form carries the gutter and the rule that separates it from
    // the row above. Class names only — nothing about the submit changed.
    <form
      action={updateDisplayName}
      className="border-t border-border px-4 py-4"
    >
      <input type="hidden" name="locale" value={locale} />
      <label className="flex flex-col gap-1 text-sm">
        {labels.displayName}
        <input
          name="display_name"
          required
          maxLength={MAX_NAME_LENGTH}
          autoComplete="off"
          defaultValue={displayName}
          className={`${FIELD} max-w-sm`}
        />
        <span className="text-xs text-muted">{labels.displayNameHint}</span>
      </label>
      <button type="submit" className={`mt-4 ${BTN_PRIMARY}`}>
        {labels.save}
      </button>
    </form>
  );
}

/**
 * 修改密码 — the current password, and the new one twice.
 *
 * All three boxes are `PasswordInput`s, so all three can be revealed: a customer
 * typing a Chinese passphrase on a phone gets no preview of the last character,
 * and masking with no way back is what produces the mistyped password the
 * account is then locked out over.
 *
 * `autoComplete` differs by box on purpose — `current-password` on the first,
 * `new-password` on the other two — which is what lets a password manager offer
 * the stored one above and propose a generated one below.
 */
export function PasswordForm({
  locale,
  labels,
}: {
  locale: string;
  labels: {
    currentPassword: string;
    newPassword: string;
    confirmPassword: string;
    passwordHint: string;
    changePassword: string;
    showPassword: string;
    hidePassword: string;
  };
}) {
  const eyes = { show: labels.showPassword, hide: labels.hidePassword };

  return (
    // Same gutter and rule as the form above, for the same reason — and the
    // width cap is INSIDE the rule, not on it. `max-w-sm` on the form itself
    // capped the very element drawing the `border-t`: past a viewport of ~418px
    // (the card's inner width is the viewport less `main`'s 32px of gutter and
    // the card's 2px of border) the divider stopped at 384px while every other
    // rule in these cards ran to the card's edge — one short rule among
    // full-bleed ones, on the desktop this portal also serves. So the form stays
    // edge to edge and the boxes are held in by the wrapper below: the same
    // 384px `DisplayNameForm` puts on its own input, spent on one wrapper here
    // because `PasswordInput` owns the input's class string and there are three
    // of them.
    <form action={changePassword} className="border-t border-border px-4 py-4">
      <input type="hidden" name="locale" value={locale} />

      <div className="grid max-w-sm gap-3">
        <label className="flex flex-col gap-1 text-sm">
          {labels.currentPassword}
          <PasswordInput
            name="current_password"
            autoComplete="current-password"
            required
            labels={eyes}
          />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          {labels.newPassword}
          <PasswordInput
            name="new_password"
            autoComplete="new-password"
            required
            minLength={MIN_PASSWORD_LENGTH}
            labels={eyes}
          />
          <span className="text-xs text-muted">{labels.passwordHint}</span>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          {labels.confirmPassword}
          <PasswordInput
            name="confirm_password"
            autoComplete="new-password"
            required
            minLength={MIN_PASSWORD_LENGTH}
            labels={eyes}
          />
        </label>

        <button
          type="submit"
          className={`mt-1 justify-self-start ${BTN_PRIMARY}`}
        >
          {labels.changePassword}
        </button>
      </div>
    </form>
  );
}
