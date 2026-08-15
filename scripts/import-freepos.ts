/**
 * Import the freepos snapshot into public.products. Idempotent by codart.
 * NEVER writes price columns (they stay NULL until the Wingest price merge).
 * Usage: pnpm dlx tsx scripts/import-freepos.ts [--dry-run]
 * Requires .env.local: NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.
 *
 * Scripts import library code relatively, like scripts/create-user.ts — house
 * style, not a tooling limit (tsx does resolve the "@/" alias).
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { parseFreeposImportSnapshot } from "../src/lib/catalog/freepos";
import {
  selectCurrentVariants,
  toProductRecord,
} from "../src/lib/catalog/import";
import type { Database } from "../src/lib/supabase/database.types";

for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
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

const dryRun = process.argv.includes("--dry-run");
const db = createClient<Database>(url, key, { auth: { persistSession: false } });

const rows = parseFreeposImportSnapshot(
  readFileSync("data/freepos/products.json"),
);
const anomalies: string[] = [];
const records = [];
for (const row of rows) {
  try {
    records.push(toProductRecord(row));
  } catch (error) {
    anomalies.push(error instanceof Error ? error.message : String(error));
  }
}

// Dedupe BEFORE variant selection: a duplicate codart that survives into
// selectCurrentVariants could win a group and then be dropped here, leaving the
// group with zero currents (the DB partial unique index only catches too-many).
const seen = new Set<string>();
const deduped = records.filter((record) => {
  if (seen.has(record.codart)) {
    anomalies.push(`duplicate codart in snapshot: ${record.codart}`);
    return false;
  }
  seen.add(record.codart);
  return true;
});
selectCurrentVariants(deduped);

const groups = new Set(deduped.map((record) => record.base_sku));
const report = {
  snapshotRows: rows.length,
  importable: deduped.length,
  anomalies: anomalies.length,
  variantGroups: groups.size,
  unavailable: deduped.filter((record) => !record.is_available).length,
  weighed: deduped.filter((record) => record.is_weighed).length,
  currents: deduped.filter((record) => record.is_current_variant).length,
};
console.log(JSON.stringify(report, null, 2));
if (anomalies.length) console.log("ANOMALIES:\n" + anomalies.join("\n"));
if (dryRun) process.exit(0);

// Two-phase write honoring the partial unique index products_one_current_variant:
// phase 1 upserts every record with is_current_variant=false (whole groups demoted),
// phase 2 promotes exactly the winners. Chunked to stay under PostgREST limits.
const CHUNK = 500;
async function upsertChunk(
  chunk: typeof deduped,
  demote: boolean,
): Promise<void> {
  // unit, units_per_case and erp_synced_at are deliberately ABSENT, like the
  // price columns: on first insert the DB defaults give unit='UNIDAD' and NULLs
  // anyway, and leaving them out of the payload means a later re-import cannot
  // clobber the real values written by the Wingest price/unit merge.
  const payload = chunk.map((record) => ({
    codart: record.codart,
    base_sku: record.base_sku,
    variant_suffix: record.variant_suffix,
    is_current_variant: demote ? false : record.is_current_variant,
    name: record.name,
    is_weighed: record.is_weighed,
    is_available: record.is_available,
    iva_rate: record.iva_rate,
  }));
  const { error } = await db
    .from("products")
    .upsert(payload, { onConflict: "codart" });
  if (error) throw new Error(`upsert failed: ${error.message}`);
}

/**
 * The write phase lives in a function because the package is CJS (no "type":
 * "module"), and tsx/esbuild refuse to emit top-level await into CJS output —
 * it is a transform-time error, so bare `await` here would break even --dry-run.
 */
async function importAll(): Promise<void> {
  for (let i = 0; i < deduped.length; i += CHUNK) {
    await upsertChunk(deduped.slice(i, i + CHUNK), true);
  }
  const winners = deduped.filter((record) => record.is_current_variant);
  for (let i = 0; i < winners.length; i += CHUNK) {
    await upsertChunk(winners.slice(i, i + CHUNK), false);
  }

  const { count } = await db
    .from("products")
    .select("*", { count: "exact", head: true });
  console.log(`products table now holds ${count} rows`);
}

importAll().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
