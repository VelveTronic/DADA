import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

/**
 * The portal's settings: one registry, one reader, and the rule that a settings
 * outage is never allowed to change what a customer sees.
 *
 * `portal_settings` is a key/value table (see the migration) and this module is
 * the closed list of what may live in it. Adding a setting is one entry in
 * `SETTINGS` — the read, the validation, the form parsing and the owner page's
 * gate all key off it — and nothing else in the app is allowed to invent a key,
 * which is what stops a crafted POST from writing rows the UI would then have to
 * defend itself against.
 *
 * **Everything here fails OPEN.** Every setting is a switch that HIDES part of
 * the portal, and each one defaults to `true` — show it. So every path that
 * cannot produce an answer — no row, a jsonb value of the wrong shape, a query
 * that errored, a database that is simply down — returns the DEFAULT. The
 * failure mode that matters is not "a hidden price leaked"; it is "the catalogue
 * silently stopped showing prices to every restaurant because one SELECT timed
 * out", and that must not be reachable from here.
 *
 * The parsing is pure and tested; the read is a four-line wrapper around it, so
 * the interesting half of this file can be exercised without a database.
 */

/** A boolean switch. The only shape a setting has today; the union grows here. */
interface BooleanSetting {
  readonly type: "boolean";
  readonly default: boolean;
}

type SettingSpec = BooleanSetting;

/**
 * Every setting the portal has, with the value it falls back to.
 *
 * `satisfies` rather than `as const`: the literal keeps its `"boolean"` type
 * (so a future union can be discriminated on it) while `default` stays a plain
 * `boolean` — under `as const` it would narrow to `true` and `SettingValue`
 * would then promise a value that can never be false.
 *
 * Both defaults are the owner's decision, recorded twice on purpose: here, and
 * as the seeded rows in the migrations. The two agree, and if a row ever
 * disappears this one still answers.
 *
 * `show_delivery_date` decides whether the CHECKOUT offers a delivery-date
 * picker at all. Off, the customer chooses nothing and the order is stored with
 * a null `delivery_date`, which the bridge already reads as "no date given" and
 * resolves to the Madrid business day (`resolveFecent`). What the switch hides
 * is the PICKER, never a date an order actually carries: an order placed while
 * it was on keeps its date, and every screen keeps showing it.
 */
export const SETTINGS = {
  show_prices: { type: "boolean", default: true },
  show_delivery_date: { type: "boolean", default: true },
} satisfies Record<string, SettingSpec>;

export type SettingKey = keyof typeof SETTINGS;

/** The registry's keys as a list, for the form gate and for tests. */
export const SETTING_KEYS = Object.keys(SETTINGS) as SettingKey[];

/** The type of one setting's value, read off its own default. */
export type SettingValue<K extends SettingKey = SettingKey> =
  (typeof SETTINGS)[K]["default"];

/**
 * What every setting falls back to, as one object.
 *
 * The page renders from this before it has read anything, and it is what the
 * reader returns on any failure — one place to look for "what does the portal do
 * when it knows nothing".
 */
export const SETTINGS_DEFAULTS: { [K in SettingKey]: SettingValue<K> } = {
  show_prices: SETTINGS.show_prices.default,
  show_delivery_date: SETTINGS.show_delivery_date.default,
};

/** Everything that can go wrong writing a setting, as a closed list of codes. */
export const SETTINGS_ERRORS = ["BAD_KEY", "BAD_VALUE", "DB_ERROR"] as const;

export type SettingsError = (typeof SETTINGS_ERRORS)[number];

/**
 * What travels back to `/staff/ajustes` as `?result=`. The parameter is
 * user-editable, so the page proves a value belongs to this list before using it
 * as a message key.
 */
export function isSettingsResult(
  value: string,
): value is "ok" | SettingsError {
  return value === "ok" || (SETTINGS_ERRORS as readonly string[]).includes(value);
}

/** A parse that answers with a value or with the reason there is none. */
export type ParsedSetting<T> =
  | { ok: true; value: T }
  | { ok: false; error: SettingsError };

export function isSettingKey(value: unknown): value is SettingKey {
  return typeof value === "string" && Object.hasOwn(SETTINGS, value);
}

/**
 * The key a form sent, proved to be one this build knows.
 *
 * The form's hidden field is the only thing that says WHICH setting is being
 * written, and a server action is an open POST endpoint — so an unknown key is
 * refused rather than upserted. Without this the table would accept any row a
 * crafted request cared to invent.
 */
export function parseSettingKey(value: unknown): ParsedSetting<SettingKey> {
  const key = typeof value === "string" ? value.trim() : "";
  return isSettingKey(key) ? { ok: true, value: key } : { ok: false, error: "BAD_KEY" };
}

/**
 * A jsonb value out of the table, validated against its registry entry.
 *
 * Anything that is not the declared type — a string where a boolean belongs, a
 * `null`, an object, a missing row's `undefined` — is the DEFAULT. This is the
 * fail-open rule stated once, and every caller inherits it.
 */
export function parseSettingValue<K extends SettingKey>(
  key: K,
  raw: unknown,
): SettingValue<K> {
  const spec: SettingSpec = SETTINGS[key];
  if (spec.type === "boolean" && typeof raw === "boolean") {
    return raw as SettingValue<K>;
  }
  return spec.default as SettingValue<K>;
}

/**
 * A form field on its way INTO the table, as a strict pair.
 *
 * The toggle posts `0` and `1` — never `on`, never an absent field — and both
 * are named here, so an unrecognised value is refused instead of collapsing to
 * one of them. `value === "1"` would turn a renamed field, a truncated body and
 * a typo into "hide every price from every customer", which is the one outcome
 * a malformed request must not be able to produce.
 *
 * Writing is the opposite of reading: a write that cannot be understood is
 * REFUSED (the owner sees a banner and tries again), while a read that cannot be
 * understood falls back to the default. Guessing is only safe in the direction
 * that changes nothing.
 */
export function parseSettingInput<K extends SettingKey>(
  key: K,
  raw: unknown,
): ParsedSetting<SettingValue<K>> {
  const spec: SettingSpec = SETTINGS[key];
  const text = typeof raw === "string" ? raw.trim() : "";
  if (spec.type === "boolean") {
    if (text === "1") return { ok: true, value: true as SettingValue<K> };
    if (text === "0") return { ok: true, value: false as SettingValue<K> };
  }
  return { ok: false, error: "BAD_VALUE" };
}

/**
 * The toggle's value, read off the form the owner just posted.
 *
 * A checkbox sends NOTHING when it is off, so the form pairs it with a hidden
 * `0` that is always sent (the classic Rails/Django idiom — see
 * `settings-form.tsx`). Both fields carry the SAME name, so the browser posts
 * `0` alone when the switch is off and `0, 1` when it is on: the LAST entry is
 * the answer, and `FormData.get` returns the FIRST.
 *
 * That off-by-one is the whole reason this lives here rather than in the server
 * action. Reading the first entry would make every save read `0` — "hide every
 * price from every restaurant", permanently, from a form the owner used to turn
 * prices ON — and a `"use server"` module is not a place a test can reach. Here
 * it is four lines of pure function with the duplicate-entry case pinned by a
 * test, and the action is left with nothing to get wrong.
 *
 * The field name is fixed rather than passed in: the pair is this form's
 * convention, and stating it once is the point of the helper.
 */
export function parseToggleFormData<K extends SettingKey>(
  formData: Pick<FormData, "getAll">,
  key: K,
): ParsedSetting<SettingValue<K>> {
  const values = formData.getAll("value");
  // Empty means the field never arrived — `parseSettingInput` refuses it rather
  // than guessing, which is the whole rule this module is built on.
  const last = values.length > 0 ? values[values.length - 1] : null;
  return parseSettingInput(key, last);
}

/**
 * The narrow client this module needs: anything that can read a table.
 *
 * Both callers satisfy it — the session client (`createServerSupabase`, which is
 * how customer pages read it under RLS) and the service-role one — because the
 * SELECT policy grants every authenticated user this row.
 */
export type SettingsClient = SupabaseClient<Database>;

/**
 * One setting, for one request.
 *
 * Every failure lands in the server log and returns the default: a page that
 * cannot reach the settings table still renders the catalogue it was asked for,
 * with prices, exactly as it did before this feature existed.
 *
 * Callers put this INSIDE the `Promise.all` they already run for their page
 * data. It is one more round trip on a connection the page is opening anyway,
 * and never a sequential one — the whole point of a settings read is that
 * nobody notices it.
 */
export async function getSetting<K extends SettingKey>(
  supabase: SettingsClient,
  key: K,
): Promise<SettingValue<K>> {
  const { data, error } = await supabase
    .from("portal_settings")
    .select("value")
    .eq("key", key)
    .maybeSingle();

  if (error) console.error(`portal_settings ${key} query:`, error);

  return parseSettingValue(key, data?.value);
}
