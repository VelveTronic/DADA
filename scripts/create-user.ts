/**
 * Create a staff or customer account from a trusted workstation.
 * See README.md for argument forms. Requires .env.local service-role credentials.
 */
import { readFileSync } from "node:fs";
import { createClient, type PostgrestError } from "@supabase/supabase-js";
import type { Database } from "../src/lib/supabase/database.types";

/**
 * On the { data, error } path PostgREST hands back a PLAIN OBJECT, not the
 * PostgrestError class it is typed as — that one is only constructed when
 * throwOnError is set. So it fails `instanceof Error` and stringifies to
 * "[object Object]"; flatten the fields an operator needs by hand instead.
 */
function describeDbError(error: PostgrestError): string {
  return [
    error.message,
    error.code && `code ${error.code}`,
    error.details,
    error.hint,
  ]
    .filter(Boolean)
    .join(" | ");
}

for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
  if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  throw new Error(
    "Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local",
  );
}

const args = process.argv.slice(2);
const [kind, email, password, displayName] = args;
if (!kind || !email || !password || !displayName) {
  throw new Error("Missing arguments; see README.md");
}
if (kind !== "staff" && kind !== "customer") {
  throw new Error(`Unknown user kind: ${kind}`);
}

const role = args[4] ?? "staff";
if (kind === "staff" && !["staff", "manager", "owner"].includes(role)) {
  throw new Error(`Invalid staff role: ${role}`);
}

const companyName = args[4];
const codcli = Number(args[5]);
const tarcli = Number(args[6] ?? 1);
if (
  kind === "customer" &&
  (!companyName ||
    !Number.isInteger(codcli) ||
    codcli <= 0 ||
    !Number.isInteger(tarcli) ||
    tarcli < 1 ||
    tarcli > 6)
) {
  throw new Error("Customer requires companyName, positive codcli and tarcli 1..6");
}

const admin = createClient<Database>(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});
/**
 * The awaiting body lives in a function because the package is CJS (no "type":
 * "module"), and tsx/esbuild refuse to emit top-level await into CJS output —
 * it is a transform-time error, so bare `await` here made the whole script
 * unrunnable, argument validation included.
 */
async function main(): Promise<void> {
  const { data: created, error: authError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (authError) throw authError;

  const userId = created.user.id;
  let companyId: string | null = null;
  try {
    if (kind === "staff") {
      const { error } = await admin.from("staff_users").insert({
        id: userId,
        role,
        display_name: displayName,
      });
      if (error) {
        throw new Error(`staff_users insert failed: ${describeDbError(error)}`);
      }
      console.log(`Created staff ${email} (${role}), uid=${userId}`);
    } else {
      const { data: company, error: companyError } = await admin
        .from("companies")
        .insert({ name: companyName!, codcli, tarcli })
        .select("id")
        .single();
      if (companyError) {
        throw new Error(
          `companies insert failed: ${describeDbError(companyError)}`,
        );
      }
      companyId = company.id;

      const { error } = await admin.from("portal_users").insert({
        id: userId,
        company_id: companyId,
        display_name: displayName,
      });
      if (error) {
        throw new Error(`portal_users insert failed: ${describeDbError(error)}`);
      }
      console.log(`Created customer ${email} for ${companyName}, uid=${userId}`);
    }
  } catch (error) {
    // Roll back what we already created. A FAILED rollback is worse than the
    // original error — it strands a half-built account only a human can clear —
    // so name the exact orphan instead of letting the cleanup fail silently.
    const { error: userCleanup } = await admin.auth.admin.deleteUser(userId);
    if (userCleanup) {
      console.error(
        `MANUAL CLEANUP NEEDED: auth user ${userId} (${userCleanup.message})`,
      );
    }
    if (companyId) {
      const { error: companyCleanup } = await admin
        .from("companies")
        .delete()
        .eq("id", companyId);
      if (companyCleanup) {
        console.error(
          `MANUAL CLEANUP NEEDED: company ${companyId} (${describeDbError(companyCleanup)})`,
        );
      }
    }
    throw error;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
