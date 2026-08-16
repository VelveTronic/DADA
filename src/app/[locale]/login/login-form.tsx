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
        <input
          name="email"
          type="email"
          required
          autoComplete="email"
          className={FIELD}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        {labels.password}
        <PasswordInput
          name="password"
          autoComplete="current-password"
          required
          labels={{ show: labels.showPassword, hide: labels.hidePassword }}
        />
      </label>
      <button type="submit" className={BTN_PRIMARY}>
        {labels.submit}
      </button>
    </form>
  );
}
