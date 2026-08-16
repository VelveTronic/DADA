"use client";

import { useState } from "react";
import { createCustomerAccount } from "@/app/actions/staff-users";
import { PasswordInput } from "@/components/password-input";
import { BTN_PRIMARY, FIELD } from "@/components/ui";
import { MAX_NAME_LENGTH, MIN_PASSWORD_LENGTH } from "@/lib/user-admin";

/** One line of the existing-company `<select>`, read by the page's admin client. */
export type CompanyOption = { id: string; name: string; codcli: number | null };

/**
 * The 新建客户账号 form: a login for a restaurant, under an existing company or
 * under one this submit creates.
 *
 * A client component for ONE reason — the company disclosure. Everything else
 * here is a plain uncontrolled field that goes straight into the Server Action's
 * FormData; the password in particular is never read into state, which is why
 * this file can be a client component at all without the value leaving the DOM.
 *
 * The two branches are mutually exclusive IN THE DOM, not merely visually: the
 * hidden `company_choice` says which one the staff member chose and the other
 * branch's inputs are unmounted, so a form that sends both — which
 * `validateNewCustomer` refuses as BAD_COMPANY rather than guessing — cannot be
 * produced by using the page normally.
 *
 * React resets an uncontrolled form after its action completes, so a created
 * account leaves empty fields behind and the next one starts clean. The chosen
 * branch is deliberately NOT reset: a staff member adding three logins to the
 * same new company would otherwise re-open the disclosure three times.
 */
export function CreateCustomerForm({
  locale,
  companies,
  labels,
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
    companyNew: string;
    companyName: string;
    codcli: string;
    tarcli: string;
    submit: string;
    noCompanies: string;
    showPassword: string;
    hidePassword: string;
  };
}) {
  // With no company on file the "existing" branch has nothing to offer, so the
  // form opens on the one choice that can succeed.
  const [choice, setChoice] = useState<"existing" | "new">(
    companies.length > 0 ? "existing" : "new",
  );

  return (
    <form action={createCustomerAccount} className="mt-3 grid gap-3 sm:grid-cols-2">
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="company_choice" value={choice} />

      <label className="flex flex-col gap-1 text-sm">
        {labels.email}
        <input
          name="email"
          type="email"
          required
          // This is somebody ELSE's address: the browser offering the staff
          // member's own saved one is the fastest way to create a wrong account.
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
        {labels.company}
        {/* No `name`: the hidden field above is what the action reads, so this
            control can stay a pure piece of UI state. */}
        <select
          value={choice}
          onChange={(event) =>
            setChoice(event.target.value === "new" ? "new" : "existing")
          }
          className={FIELD}
        >
          <option value="existing" disabled={companies.length === 0}>
            {labels.companyExisting}
          </option>
          <option value="new">{labels.companyNew}</option>
        </select>
      </label>

      {choice === "existing" ? (
        <label className="flex flex-col gap-1 text-sm sm:col-span-2">
          {labels.companyExisting}
          <select name="company_id" required defaultValue="" className={FIELD}>
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
                className={FIELD}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              {labels.tarcli}
              {/* Which of the six price columns this restaurant will see. */}
              <select name="tarcli" defaultValue="1" className={FIELD}>
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

      <div className="sm:col-span-2">
        <button type="submit" className={BTN_PRIMARY}>
          {labels.submit}
        </button>
      </div>
    </form>
  );
}
