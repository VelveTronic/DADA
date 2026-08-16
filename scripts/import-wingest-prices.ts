/**
 * Merge Wingest price tiers + units into public.products by codart, from the
 * CSV that scripts/wingest/export-prices.ps1 produces on the ERP server.
 *
 * Zero tiers become NULL (a zero in Wingest means "no price"; a 0-cent price
 * would let create_order sell the product for free). Products absent from the
 * CSV are left untouched, and so are the products whose CSV row carries no unit.
 *
 * The ERP owns prices and units_per_case, so those columns are OVERWRITTEN from
 * the CSV on every run, NULL prices included. `unit` and `is_weighed` are only
 * ever given a value, never cleared: staff may have corrected them by hand.
 * `units_per_case` is never NULL — a UNILOT the ERP does not have means "one
 * caja is one unit", which is the number 1 (see `toWingestPricePatch`).
 *
 * Usage: pnpm import:wingest-prices <prices.csv> [--dry-run]
 * --dry-run parses and reports without reading .env.local or touching the DB,
 * and prints ONE JSON document. A write run requires .env.local
 * (NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY) and prints TWO: the
 * merge report, then the post-merge diagnostics. Progress and anomalies go to
 * stderr so both documents stay machine-readable.
 *
 * The CSV is confidential — the full six-tier price matrix. It is gitignored at
 * scripts/wingest/prices.csv; delete it once the merge has run.
 *
 * Scripts import library code relatively, like scripts/create-user.ts — house
 * style, not a tooling limit (tsx does resolve the "@/" alias).
 */
import { readFileSync } from "node:fs";
import { createClient, type PostgrestError } from "@supabase/supabase-js";
import {
  hasAnyPrice,
  parseWingestPriceCsv,
  toWingestPricePatch,
  type WingestPricePatch,
  type WingestPriceRow,
} from "../src/lib/catalog/wingest";
import type { Database } from "../src/lib/supabase/database.types";

const USAGE = "Usage: pnpm import:wingest-prices <prices.csv> [--dry-run]";
/** 2900+ single-row updates take minutes; say something so it does not look hung. */
const PROGRESS_EVERY = 500;
const NOT_IN_PORTAL_SAMPLE = 20;

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

/**
 * Distinct trimmed/uppercased unidad values with their counts, commonest first.
 * is_weighed is derived from an EXACT match on KG, so the operator has to be
 * able to see the ERP's real vocabulary — KG against KGS, KILO, KG. — in the
 * dry run, before a write commits the wrong flag on every weighed product.
 */
function unidadHistogram(rows: WingestPriceRow[]): Record<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const unidad = row.unidad.trim().toUpperCase() || "(empty)";
    counts.set(unidad, (counts.get(unidad) ?? 0) + 1);
  }
  return Object.fromEntries(
    [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
  );
}

/**
 * Fail CLOSED on anything that is not exactly one CSV path plus an optional
 * --dry-run. A second path, or a typo like "--dryrun", must never be swallowed
 * as "no flag given" and silently run the REAL merge against the catalog.
 */
function parseArgs(argv: string[]): { csvPath: string; dryRun: boolean } {
  const flags = argv.filter((arg) => arg.startsWith("--"));
  const positionals = argv.filter((arg) => !arg.startsWith("--"));
  const unknownFlags = flags.filter((flag) => flag !== "--dry-run");
  if (unknownFlags.length || positionals.length !== 1) {
    if (unknownFlags.length) {
      console.error(`Unknown argument(s): ${unknownFlags.join(" ")}`);
    } else if (positionals.length === 0) {
      console.error("Missing the CSV path");
    } else {
      console.error(`Expected one CSV path, got ${positionals.length}`);
    }
    console.error(USAGE);
    process.exit(1);
  }
  return { csvPath: positionals[0], dryRun: flags.includes("--dry-run") };
}

function serviceClient() {
  let envFile = "";
  try {
    envFile = readFileSync(".env.local", "utf8");
  } catch {
    // Absent .env.local is not fatal on its own: the operator may have exported
    // the two variables into the session instead. The check below decides.
    envFile = "";
  }
  for (const line of envFile.split(/\r?\n/)) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error(
      "Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local",
    );
    process.exit(1);
  }
  return createClient<Database>(url, key, { auth: { persistSession: false } });
}

type ServiceClient = ReturnType<typeof serviceClient>;

/** Products still carrying no price at all in any of the six tiers. */
async function countFullyUnpriced(db: ServiceClient): Promise<number | null> {
  const { count, error } = await db
    .from("products")
    .select("*", { count: "exact", head: true })
    .is("price_1_cents", null)
    .is("price_2_cents", null)
    .is("price_3_cents", null)
    .is("price_4_cents", null)
    .is("price_5_cents", null)
    .is("price_6_cents", null);
  if (error) {
    throw new Error(`fully-unpriced count failed: ${describeDbError(error)}`);
  }
  return count;
}

/**
 * Orderable (available AND current variant) with at least one tier priced. Not
 * the same as "orderable for a given customer": create_order resolves the one
 * tier that customer's company sits on, so a product priced only on tier 3 is
 * still NO_PRICE for a tier 1 company.
 */
async function countOrderableWithPrice(db: ServiceClient): Promise<number | null> {
  const { count, error } = await db
    .from("products")
    .select("*", { count: "exact", head: true })
    .eq("is_orderable", true)
    .or(
      "price_1_cents.not.is.null,price_2_cents.not.is.null," +
        "price_3_cents.not.is.null,price_4_cents.not.is.null," +
        "price_5_cents.not.is.null,price_6_cents.not.is.null",
    );
  if (error) {
    throw new Error(`orderable-with-price count failed: ${describeDbError(error)}`);
  }
  return count;
}

/**
 * The awaiting body lives in a function because the package is CJS (no "type":
 * "module"), and tsx/esbuild refuse to emit top-level await into CJS output —
 * it is a transform-time error, so bare `await` here would break the script
 * outright, --dry-run and argument validation included.
 */
async function main(): Promise<void> {
  const { csvPath, dryRun } = parseArgs(process.argv.slice(2));

  let csvText: string;
  try {
    csvText = readFileSync(csvPath, "utf8");
  } catch (error) {
    throw new Error(
      `cannot read ${csvPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const rows = parseWingestPriceCsv(csvText);
  // One timestamp for the whole run: every row it touches carries the same
  // erp_synced_at, so a partial run is visible as a timestamp split.
  const syncedAt = new Date().toISOString();
  const patches: { codart: string; patch: WingestPricePatch }[] = rows.map(
    (row) => ({ codart: row.codart, patch: toWingestPricePatch(row, syncedAt) }),
  );

  const priced = patches.filter((entry) => hasAnyPrice(entry.patch)).length;
  const report: Record<string, unknown> = {
    csvRows: patches.length,
    csvWithAnyPrice: priced,
    csvFullyZeroPriced: patches.length - priced,
    unitWrites: patches.filter((entry) => entry.patch.unit !== undefined).length,
    weighedFromKg: patches.filter((entry) => entry.patch.is_weighed).length,
    // Products the ERP really does sell by the case. A factor of 1 is the
    // fallback as much as it is a value, so counting it would report the whole
    // catalogue as cased and tell the operator nothing.
    unitsPerCaseSet: patches.filter((entry) => entry.patch.units_per_case > 1)
      .length,
    unidadValues: unidadHistogram(rows),
  };

  if (dryRun) {
    report.dryRun = true;
    report.samplePatches = patches.slice(0, 3);
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const db = serviceClient();
  let matched = 0;
  let notInPortal = 0;
  const notInPortalSample: string[] = [];
  for (const [index, { codart, patch }] of patches.entries()) {
    const { data, error } = await db
      .from("products")
      .update(patch)
      .eq("codart", codart)
      .select("codart");
    // Name the codart and the position: a mid-run failure leaves the rows before
    // it already merged, and the operator needs to know both which SKU broke and
    // how far the run got before deciding to re-run (re-running is safe — the
    // merge is idempotent by codart).
    if (error) {
      throw new Error(
        `update failed for codart ${codart} (row ${index + 1}/${patches.length}): ` +
          describeDbError(error),
      );
    }
    // data.length is 0 or 1 and never more: codart is unique, so a "rows
    // updated" tally would only ever restate matched.
    if (data.length === 0) {
      notInPortal++;
      if (notInPortalSample.length < NOT_IN_PORTAL_SAMPLE) {
        notInPortalSample.push(codart);
      }
    } else {
      matched++;
    }
    // Progress on stderr so the single JSON report on stdout stays pipeable.
    if ((index + 1) % PROGRESS_EVERY === 0) {
      console.error(`... ${index + 1}/${patches.length} rows applied`);
    }
  }

  // Print what the writes did BEFORE asking the database anything else. The two
  // counts below are diagnostics; losing them to a network blip must not also
  // lose the only record of how 2900+ updates went.
  report.matched = matched;
  report.notInPortal = notInPortal;
  console.log(JSON.stringify(report, null, 2));
  if (notInPortalSample.length) {
    console.error(
      `first not-in-portal codarts: ${notInPortalSample.join(", ")}`,
    );
  }

  // Second document on stdout, so the merge report above stays exactly what it
  // was when it was printed. A failure here is reported, not thrown: the merge
  // itself already succeeded, and exiting non-zero would read as "the catalog
  // did not get its prices" and invite a pointless re-run.
  const diagnostics: Record<string, unknown> = {};
  try {
    diagnostics.productsFullyUnpriced = await countFullyUnpriced(db);
    diagnostics.productsOrderableWithPrice = await countOrderableWithPrice(db);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    diagnostics.countError = message;
    console.error(`post-merge diagnostics failed: ${message}`);
  }
  console.log(JSON.stringify(diagnostics, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
