"use client";

import { createStaffAccount } from "@/app/actions/staff-users";
import { PasswordInput } from "@/components/password-input";
import { BTN_PRIMARY, FIELD } from "@/components/ui";
import {
  MAX_NAME_LENGTH,
  MIN_PASSWORD_LENGTH,
  STAFF_ROLES,
  type StaffRole,
} from "@/lib/user-admin";

/**
 * The 新建员工账号 form — the 超级管理员 power, rendered only for an owner.
 *
 * A client component only because `PasswordInput` is one (the eye toggle owns a
 * boolean); the fields themselves are uncontrolled and go straight into the
 * Server Action's FormData. `createStaffAccount` re-checks `canManageStaff`
 * regardless of who could see this form: a Server Action is its own POST
 * endpoint, and a hidden form is not a permission.
 *
 * The role options come from `STAFF_ROLES` rather than from three literals, so
 * a fourth role added to the column's check constraint appears here as soon as
 * it has a label instead of silently going missing.
 */
export function CreateStaffForm({
  locale,
  labels,
  roleLabels,
}: {
  locale: string;
  /** Already localized by the server page — this leaf does no translation. */
  labels: {
    email: string;
    password: string;
    passwordHint: string;
    displayName: string;
    role: string;
    submit: string;
    showPassword: string;
    hidePassword: string;
  };
  roleLabels: Record<StaffRole, string>;
}) {
  return (
    <form action={createStaffAccount} className="mt-3 grid gap-3 sm:grid-cols-2">
      <input type="hidden" name="locale" value={locale} />

      <label className="flex flex-col gap-1 text-sm">
        {labels.email}
        <input
          name="email"
          type="email"
          required
          // Somebody else's address; the staff member's own saved one would be
          // the fastest way to create the wrong account.
          autoComplete="off"
          className={FIELD}
        />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        {labels.password}
        <PasswordInput
          name="password"
          autoComplete="new-password"
          required
          minLength={MIN_PASSWORD_LENGTH}
          labels={{ show: labels.showPassword, hide: labels.hidePassword }}
        />
        <span className="text-xs text-muted">{labels.passwordHint}</span>
      </label>

      <label className="flex flex-col gap-1 text-sm">
        {labels.displayName}
        <input
          name="display_name"
          required
          maxLength={MAX_NAME_LENGTH}
          autoComplete="off"
          className={FIELD}
        />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        {labels.role}
        <select name="role" defaultValue="staff" className={FIELD}>
          {STAFF_ROLES.map((role) => (
            <option key={role} value={role}>
              {roleLabels[role]}
            </option>
          ))}
        </select>
      </label>

      <div className="sm:col-span-2">
        <button type="submit" className={BTN_PRIMARY}>
          {labels.submit}
        </button>
      </div>
    </form>
  );
}
