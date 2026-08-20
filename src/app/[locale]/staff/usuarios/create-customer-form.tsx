"use client";

import { useActionState, useState } from "react";
import { createCustomerAccount } from "@/app/actions/staff-users";
import { PasswordInput } from "@/components/password-input";
import { BTN_PRIMARY, FIELD } from "@/components/ui";
import {
  EMPTY_CREATE_STATE,
  MAX_NAME_LENGTH,
  MIN_PASSWORD_LENGTH,
  type UserAdminError,
} from "@/lib/user-admin";

/** One line of the existing-company `<select>`, read by the page's admin client. */
export type CompanyOption = { id: string; name: string; codcli: number | null };

/**
 * The 新建客户账号 form: a login for a restaurant, under an existing company or
 * under one this submit creates.
 *
 * A client component for two reasons — the company disclosure, and the failure
 * state below. Everything else here is a plain uncontrolled field that goes
 * straight into the Server Action's FormData; the password in particular is
 * never read into state, which is why this file can be a client component at all
 * without the value leaving the DOM.
 *
 * The two branches are mutually exclusive IN THE DOM, not merely visually: the
 * `company_choice` radios say which one the staff member chose and the other
 * branch's inputs are unmounted, so a form that sends both — which
 * `validateNewCustomer` refuses as BAD_COMPANY rather than guessing — cannot be
 * produced by using the page normally.
 *
 * React resets an uncontrolled form after its action completes, and it resets to
 * whatever `defaultValue` the same commit put on each field. That is the whole
 * mechanism here: a REJECTED create returns the values it was sent (minus the
 * password) and they are the defaults the reset lands on, so the staff member
 * fixes the one field that was wrong instead of retyping four. A SUCCESS returns
 * nothing — it redirects — so `defaultValue` is empty again and the next account
 * starts clean.
 *
 * The password is the deliberate exception: it is not in the returned values and
 * it is always retyped.
 *
 * The chosen branch survives a REJECTED submit and only that: `choice` is this
 * component's own state, and nothing about a failure unmounts the component — so
 * a staff member adding three logins to the same new company does not re-open
 * the disclosure three times. A SUCCESS is the other case entirely: the redirect
 * is thrown past this form to Next's redirect boundary, which unmounts the
 * subtree while it navigates, so the next render starts from a fresh `useState`
 * and a fresh `EMPTY_CREATE_STATE` — no stale error, no stale branch.
 */
export function CreateCustomerForm({
  locale,
  companies,
  labels,
  errorLabels,
}: {
  locale: string;
  companies: CompanyOption[];
  /** Already localized by the server page — this leaf does no translation. */
  labels: {
    email: string;
    password: string;
    passwordHint: string;
    displayName: string;
    company: string;
    companyExisting: string;
    companyExistingHint: string;
    companyNew: string;
    companyNewHint: string;
    companyPick: string;
    companyName: string;
    codcli: string;
    codcliHint: string;
    tarcli: string;
    submit: string;
    noCompanies: string;
    showPassword: string;
    hidePassword: string;
  };
  /** The same `staff.users.results.*` sentences the page's banner draws from. */
  errorLabels: Record<UserAdminError, string>;
}) {
  const [state, formAction, pending] = useActionState(
    createCustomerAccount,
    EMPTY_CREATE_STATE,
  );
  /** The last rejected submission, or nothing on a first render or a success. */
  const kept = state.values;

  // With no company on file the "existing" branch has nothing to offer, so the
  // form opens on the one choice that can succeed.
  const [choice, setChoice] = useState<"existing" | "new">(
    companies.length > 0 ? "existing" : "new",
  );

  return (
    <form action={formAction} className="mt-3 grid gap-3 sm:grid-cols-2">
      <input type="hidden" name="locale" value={locale} />

      <label className="flex flex-col gap-1 text-sm">
        {labels.email}
        <input
          name="email"
          type="email"
          required
          // This is somebody ELSE's address: the browser offering the staff
          // member's own saved one is the fastest way to create a wrong account.
          autoComplete="off"
          defaultValue={kept?.email ?? ""}
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
          defaultValue={kept?.displayName ?? ""}
          className={FIELD}
        />
      </label>

      {/* The two modes as VISIBLE radio cards, not a dropdown. The dropdown
          version hid 新建公司 behind a closed select whose first option read
          like a placeholder — the owner stood in front of this form on
          2026-08-20 and could not find where the Wingest customer number goes,
          which for a mode switch is the whole verdict. Both cards now state
          their meaning up front, the new-company card names the codcli
          capability on its face, and the radios ARE the `company_choice`
          field (the hidden input is gone — a checked radio submits its own
          value). Branch exclusivity in the DOM is unchanged. */}
      <fieldset className="sm:col-span-2">
        <legend className="text-sm">{labels.company}</legend>
        <div className="mt-1 grid gap-2 sm:grid-cols-2">
          {(
            [
              {
                mode: "existing" as const,
                title: labels.companyExisting,
                hint: labels.companyExistingHint,
                disabled: companies.length === 0,
              },
              {
                mode: "new" as const,
                title: labels.companyNew,
                hint: labels.companyNewHint,
                disabled: false,
              },
            ]
          ).map(({ mode, title, hint, disabled }) => (
            <label
              key={mode}
              className={`flex cursor-pointer flex-col gap-0.5 rounded-[10px] border p-3 transition-colors ${
                choice === mode
                  ? "border-brand bg-brand-soft/40"
                  : "border-border-strong hover:border-brand"
              } ${disabled ? "cursor-not-allowed opacity-50" : ""}`}
            >
              <span className="flex items-center gap-2 text-sm font-medium">
                <input
                  type="radio"
                  name="company_choice"
                  value={mode}
                  checked={choice === mode}
                  disabled={disabled}
                  onChange={() => setChoice(mode)}
                  className="size-4 accent-[#E0231C]"
                />
                {title}
              </span>
              <span className="pl-6 text-xs text-muted">{hint}</span>
            </label>
          ))}
        </div>
      </fieldset>

      {choice === "existing" ? (
        <label className="flex flex-col gap-1 text-sm sm:col-span-2">
          {labels.companyPick}
          {/* The `key` is what makes the restore work on a SELECT. React applies
              a `defaultValue` to a select's options when it MOUNTS and never
              again — an uncontrolled select whose defaultValue prop changes is
              left alone — so without a key the form's reset would land this back
              on the placeholder while the text fields beside it kept their
              values. Keying it by the value it should hold remounts it exactly
              when that value changes. Verified in the browser, 2026-08-16. */}
          <select
            key={kept?.companyId ?? ""}
            name="company_id"
            required
            defaultValue={kept?.companyId ?? ""}
            className={FIELD}
          >
            <option value="" disabled>
              {companies.length > 0 ? "—" : labels.noCompanies}
            </option>
            {companies.map((company) => (
              <option key={company.id} value={company.id}>
                {company.name}
                {company.codcli == null ? "" : ` · ${company.codcli}`}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <>
          <label className="flex flex-col gap-1 text-sm">
            {labels.companyName}
            <input
              name="company_name"
              required
              maxLength={MAX_NAME_LENGTH}
              defaultValue={kept?.companyName ?? ""}
              className={FIELD}
            />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1 text-sm">
              {labels.codcli}
              {/* The ERP's customer number: the bridge matches albaranes on it,
                  so it is an integer, positive, and unique across companies. */}
              <input
                name="codcli"
                type="number"
                min={1}
                step={1}
                required
                // A rejected codcli comes back exactly as it was typed, so the
                // staff member can see what the ERP already had.
                defaultValue={kept?.codcli ?? ""}
                className={FIELD}
              />
              <span className="text-xs text-muted">{labels.codcliHint}</span>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              {labels.tarcli}
              {/* Which of the six price columns this restaurant will see. */}
              {/* Keyed for the same reason as the company select above. */}
              <select
                key={kept?.tarcli || "1"}
                name="tarcli"
                defaultValue={kept?.tarcli || "1"}
                className={FIELD}
              >
                {[1, 2, 3, 4, 5, 6].map((tier) => (
                  <option key={tier} value={tier}>
                    {tier}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </>
      )}

      <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
        <button type="submit" disabled={pending} className={BTN_PRIMARY}>
          {labels.submit}
        </button>
        {/* Beside the button rather than at the top of the page: this is the
            answer to THIS submit, and the fields it talks about are here. */}
        {state.error && (
          <p role="alert" className="text-sm text-red-700">
            {errorLabels[state.error]}
          </p>
        )}
      </div>
    </form>
  );
}
