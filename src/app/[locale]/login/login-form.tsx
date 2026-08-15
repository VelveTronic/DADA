"use client";

import { signIn } from "@/app/actions/auth";
import { BTN_PRIMARY, FIELD } from "@/components/ui";

export function LoginForm({
  locale,
  labels,
}: {
  locale: string;
  labels: { email: string; password: string; submit: string };
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
        <input
          name="password"
          type="password"
          required
          autoComplete="current-password"
          className={FIELD}
        />
      </label>
      <button type="submit" className={BTN_PRIMARY}>
        {labels.submit}
      </button>
    </form>
  );
}
