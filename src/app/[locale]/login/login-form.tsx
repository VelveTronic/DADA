"use client";

import { signIn } from "@/app/actions/auth";
import { PasswordInput } from "@/components/password-input";
import { BTN_PRIMARY, FIELD } from "@/components/ui";

export function LoginForm({
  locale,
  labels,
}: {
  locale: string;
  labels: {
    email: string;
    password: string;
    submit: string;
    /** Names the eye toggle in each of its two states. */
    showPassword: string;
    hidePassword: string;
  };
}) {
  return (
    <form action={signIn} className="flex flex-col gap-4">
      <input type="hidden" name="locale" value={locale} />
      <label className="flex flex-col gap-1 text-sm">
        {labels.email}
        {/* `h-11` — 44px, the touch target Apple and WCAG 2.5.5 both ask for.
            `FIELD`'s own box is its padding plus whatever the inherited 14px
            gives it (38px), which is fine inside a list row and short for the
            two boxes a phone's whole login screen is made of. Height only: no
            `FIELD` class is overridden, so there is no one-class race here. */}
        <input
          name="email"
          type="email"
          required
          autoComplete="email"
          className={`${FIELD} h-11`}
        />
      </label>
      {/* The same 44px on the password box, reached from the LABEL because the
          input itself is not ours to class: `PasswordInput` owns that string
          (the `relative` wrapper and the `pr-10` that clears the eye button are
          its geometry), and this is the only screen that wants a taller field.
          These two boxes ARE the screen — one card on an otherwise empty page,
          nothing else to press — while /perfil's three sit in a form under a
          section head, one card in a stack of them, at the size the list rows
          around it are written in. A prop on the shared component would be a
          knob with one user.
          `[&_input]:h-11` sets a property `FIELD` never names, so there is
          nothing here for it to fight with either. */}
      <label className="flex flex-col gap-1 text-sm [&_input]:h-11">
        {labels.password}
        <PasswordInput
          name="password"
          autoComplete="current-password"
          required
          labels={{ show: labels.showPassword, hide: labels.hidePassword }}
        />
      </label>
      {/* Composed rather than a second button vocabulary: `BTN_PRIMARY` names
          no height, no width and no size, so all three are additions and none
          of them is a race — and the radius is emphatically NOT overridden, so
          this is the same control the rest of the portal draws. */}
      <button
        type="submit"
        className={`${BTN_PRIMARY} h-12 w-full text-[15px]`}
      >
        {labels.submit}
      </button>
    </form>
  );
}
