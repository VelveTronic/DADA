"use client";

import { signIn } from "@/app/actions/auth";

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
          className="rounded border px-3 py-2"
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        {labels.password}
        <input
          name="password"
          type="password"
          required
          autoComplete="current-password"
          className="rounded border px-3 py-2"
        />
      </label>
      <button type="submit" className="rounded bg-black px-3 py-2 text-white">
        {labels.submit}
      </button>
    </form>
  );
}
