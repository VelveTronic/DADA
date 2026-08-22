"use client";

import { useFormStatus } from "react-dom";

/** Prevent a double press from posting the same order transition twice. */
export function TransitionSubmitButton({
  label,
  pendingLabel,
  ariaLabel,
  className,
}: {
  label: string;
  pendingLabel: string;
  ariaLabel: string;
  className: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      aria-label={ariaLabel}
      className={`${className} disabled:cursor-not-allowed disabled:opacity-45`}
    >
      {pending ? pendingLabel : label}
    </button>
  );
}
