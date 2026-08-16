/**
 * The price job: `scripts/import-wingest-prices.ts` with the CSV taken out.
 *
 * The CSV path exists because a human on the ERP server ran a PowerShell export
 * and carried the file to the portal workstation. Once the bridge is on that
 * server it can read `articulo` itself — but the MERGE RULES must not fork. Zero
 * means "no price" and becomes NULL; `unit` is only ever written, never cleared;
 * `is_weighed` is only ever set true, and only from unit KG. Those decisions are
 * one function, `toWingestPricePatch`, and this job reuses it rather than
 * restating it: two implementations of "what does a zero tier mean" is one
 * implementation too many, and the divergence would show up as products silently
 * sold for nothing.
 *
 * `WingestPriceRow` is CSV-shaped (every field a string) by design, so the SQL
 * path stringifies its columns with `String(value ?? "")` and hands over rows the
 * transform cannot tell from parsed CSV lines.
 */
import {
  hasAnyPrice,
  toWingestPricePatch,
  type WingestPriceRow,
} from "@/lib/catalog/wingest";
import type { BridgeConfig } from "../config";
import type { Logger } from "../log";
import type { BridgeSupabase } from "../supabase";
import type { SqlParent } from "../injector";
import type { JobCounts, JobResult } from "./shared";

/**
 * The same SELECT `scripts/wingest/export-prices.ps1` runs, column for column —
 * the CSV's `codart,p1..p6,unidad,unilot` in ERP names. RTRIM because CODART and
 * UNIDAD are `char` columns: without it every codart arrives padded to its full
 * width and matches no product in the portal.
 */
export const ARTICULO_PRICE_SQL =
  "SELECT RTRIM(CODART) AS codart, " +
  "PREVENA, PREVENB, PREVENC, PREVEND, PREVENE, PREVENF, " +
  "RTRIM(UNIDAD) AS unidad, UNILOT " +
  "FROM articulo";

/** Products with no price in ANY of the six tiers — create_order's NO_PRICE set. */
export const FULLY_UNPRICED_FILTERS: Record<string, string> = {
  price_1_cents: "is.null",
  price_2_cents: "is.null",
  price_3_cents: "is.null",
  price_4_cents: "is.null",
  price_5_cents: "is.null",
  price_6_cents: "is.null",
};

/**
 * Orderable AND priced on at least one tier. Not the same as "orderable for a
 * given customer": a product priced only on tier 3 is still NO_PRICE for a
 * company sitting on tier 1.
 */
export const ORDERABLE_WITH_PRICE_FILTERS: Record<string, string> = {
  is_orderable: "eq.true",
  or:
    "(price_1_cents.not.is.null,price_2_cents.not.is.null," +
    "price_3_cents.not.is.null,price_4_cents.not.is.null," +
    "price_5_cents.not.is.null,price_6_cents.not.is.null)",
};

/** ~3k single-row PATCHes take minutes; say something so it does not look hung. */
const PROGRESS_EVERY = 500;

/**
 * How many unmatched codarts the summary names, as the CSV importer does.
 *
 * A bare `notInPortal=412` cannot be acted on: the operator needs to see whether
 * those are the ERP's internal articles (packaging, services) or a whole product
 * family the portal import missed. Twenty is enough to tell those apart and
 * short enough to stay on one log line.
 */
const NOT_IN_PORTAL_SAMPLE = 20;

export interface PriceSyncDeps {
  cfg: BridgeConfig;
  api: Pick<BridgeSupabase, "patchProduct" | "countProducts">;
  log: Logger;
  connect: (cfg: BridgeConfig) => Promise<SqlParent & { close(): Promise<unknown> }>;
  now?: () => Date;
}

export interface PriceSyncTally {
  /** Rows `articulo` returned. */
  articles: number;
  /** Rows whose codart exists in the portal catalog. */
  matched: number;
  /** Rows with no product to merge into — ERP articles the portal never imported. */
  notInPortal: number;
  /** Rows with an empty CODART: nothing to match on. */
  skipped: number;
  fullyUnpriced: number | null;
  orderableWithPrice: number | null;
  /** Set when the post-run diagnostics failed; the merge itself still stands. */
  countError?: string;
  /** Set when the merge itself stopped part-way. */
  error?: string;
}

export function emptyPriceSyncTally(): PriceSyncTally {
  return {
    articles: 0,
    matched: 0,
    notInPortal: 0,
    skipped: 0,
    fullyUnpriced: null,
    orderableWithPrice: null,
  };
}

/**
 * The summary line: the five fields the plan names, plus the two that only
 * appear when something went wrong and `skipped` only when it is not zero.
 * `matched + notInPortal + skipped === articles` on a complete run.
 */
export function priceSyncCounts(tally: PriceSyncTally): JobCounts {
  const counts: JobCounts = {
    articles: tally.articles,
    matched: tally.matched,
    notInPortal: tally.notInPortal,
    fullyUnpriced: tally.fullyUnpriced,
    orderableWithPrice: tally.orderableWithPrice,
  };
  if (tally.skipped > 0) counts.skipped = tally.skipped;
  if (tally.countError) counts.countError = tally.countError;
  if (tally.error) counts.error = tally.error;
  return counts;
}

/**
 * One `articulo` row → the CSV-shaped row the shared transform expects.
 *
 * `String(value ?? "")` is the whole adapter: a NULL money column and an empty
 * CSV cell both become "", which is the case `toWingestPricePatch` already
 * distinguishes from a real zero. Numbers stringify losslessly for anything a
 * price column can hold.
 */
export function toPriceRow(row: Record<string, unknown>): WingestPriceRow {
  const text = (value: unknown): string => String(value ?? "");
  return {
    codart: text(row.codart).trim(),
    p1: text(row.PREVENA),
    p2: text(row.PREVENB),
    p3: text(row.PREVENC),
    p4: text(row.PREVEND),
    p5: text(row.PREVENE),
    p6: text(row.PREVENF),
    unidad: text(row.unidad),
    unilot: text(row.UNILOT),
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runPriceSync(deps: PriceSyncDeps): Promise<JobResult> {
  const { cfg, api, log, connect, now = () => new Date() } = deps;
  const tally = emptyPriceSyncTally();

  const pool = await connect(cfg);
  let rows: Record<string, unknown>[];
  try {
    const result = await pool.request().query<Record<string, unknown>>(ARTICULO_PRICE_SQL);
    rows = result.recordset ?? [];
  } finally {
    // The ERP is done being read before the first PATCH goes out: holding a SQL
    // connection open across several minutes of HTTPS round trips would pin an
    // ERP session for no reason.
    try {
      await pool.close();
    } catch (error) {
      log.logError(error, { stage: "pool_close" });
    }
  }

  tally.articles = rows.length;
  log.info("read articulo", { articles: rows.length });

  // One timestamp for the whole run, exactly as the CSV importer does: every row
  // this run touches carries the same erp_synced_at, so a partial run is visible
  // in the data as a timestamp split rather than a smear.
  const syncedAt = now().toISOString();
  let withAnyPrice = 0;
  let ok = true;
  const notInPortalSample: string[] = [];

  for (const [index, raw] of rows.entries()) {
    const row = toPriceRow(raw);
    if (!row.codart) {
      tally.skipped++;
      log.warn("articulo row has an empty CODART", { position: index + 1 });
      continue;
    }
    try {
      const patch = toWingestPricePatch(row, syncedAt);
      if (hasAnyPrice(patch)) withAnyPrice++;
      if (await api.patchProduct(row.codart, patch)) {
        tally.matched++;
      } else {
        tally.notInPortal++;
        if (notInPortalSample.length < NOT_IN_PORTAL_SAMPLE) {
          notInPortalSample.push(row.codart);
        }
      }
    } catch (error) {
      // Name the codart AND the position: the rows before it are already merged,
      // and the operator needs to know both which article broke and how far the
      // run got. Re-running is safe — the merge is idempotent by codart.
      tally.error = describe(error);
      ok = false;
      log.logError(error, {
        codart: row.codart,
        position: `${index + 1}/${rows.length}`,
        stage: "patch",
      });
      break;
    }
    if ((index + 1) % PROGRESS_EVERY === 0) {
      log.info("progress", { applied: index + 1, of: rows.length });
    }
  }

  log.info("merged", {
    matched: tally.matched,
    notInPortal: tally.notInPortal,
    withAnyPrice,
    syncedAt,
    // Named, not just counted — see NOT_IN_PORTAL_SAMPLE. Absent when every
    // article matched, because `sample=` with nothing after it is noise.
    sample: notInPortalSample.length ? notInPortalSample.join(",") : null,
  });

  // Diagnostics, not results. A failure here is recorded in the summary and
  // nowhere else: the merge above already happened, and reporting the run as
  // failed because a COUNT timed out would invite a pointless re-run.
  try {
    tally.fullyUnpriced = await api.countProducts(FULLY_UNPRICED_FILTERS);
    tally.orderableWithPrice = await api.countProducts(ORDERABLE_WITH_PRICE_FILTERS);
  } catch (error) {
    tally.countError = describe(error);
    log.logError(error, { stage: "diagnostics" });
  }

  return { ok, counts: priceSyncCounts(tally) };
}
