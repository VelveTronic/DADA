/**
 * The albarán job: notice that Wingest has turned one of our pedidos into a
 * delivery note, and write that number back to the portal order.
 *
 * The direction matters. Nothing here writes to the ERP — the conversion is a
 * human pressing "Albarán" in the Wingest UI, on their own schedule, and this
 * job only reads `albfacca` and reports what it finds. The portal order moves
 * `injected` → `albaran`, which is what the customer sees as 已出单.
 *
 * The query is driven by the PORTAL's list of injected orders rather than by
 * scanning `albfacca` for recent rows: the portal knows exactly which NUMPEDs it
 * is waiting for (a handful), and the ERP's albarán table holds every delivery
 * note the company has ever issued.
 */
import type { BridgeConfig } from "../config";
import { P, applyParams, toNumber, type ParamMap, type SqlParent } from "../injector";
import type { Logger } from "../log";
import type { BridgeSupabase, InjectedOrderRef } from "../supabase";
import type { JobCounts, JobResult } from "./shared";

/**
 * NUMPEDs per query. SQL Server's hard ceiling on parameters is 2100 and its
 * plan cache would hold one plan per distinct list length; 200 keeps both far
 * away and still asks once for any realistic backlog.
 */
export const ALBARAN_CHUNK_SIZE = 200;

export interface AlbaranDeps {
  cfg: BridgeConfig;
  api: Pick<BridgeSupabase, "listInjected" | "markAlbaran">;
  log: Logger;
  connect: (cfg: BridgeConfig) => Promise<SqlParent & { close(): Promise<unknown> }>;
}

/**
 * `injected` counts DISTINCT NUMPEDs, not portal orders — it is the size of the
 * set this run asked `albfacca` about. `matched` counts the NUMPEDs that came
 * back with a usable albarán, and can never exceed `injected`: a pedido is
 * removed from the waiting set the moment it matches, so the several albfacca
 * rows one pedido produces across partial deliveries count once.
 *
 * `marked` counts ORDER rows confirmed by `bridge_mark_albaran`, so it equals
 * `matched` in every normal run and exceeds it only if two portal orders somehow
 * share a NUMPED — the collision this job warns about rather than hides.
 */
export interface AlbaranTally {
  injected: number;
  matched: number;
  marked: number;
}

export function emptyAlbaranTally(): AlbaranTally {
  return { injected: 0, matched: 0, marked: 0 };
}

/** The summary line's fields, in the order the plan names them. */
export function albaranCounts(tally: AlbaranTally): JobCounts {
  return {
    injected: tally.injected,
    matched: tally.matched,
    marked: tally.marked,
  };
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (!Number.isInteger(size) || size < 1) {
    throw new Error(`chunk size must be a positive integer, got ${size}`);
  }
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    out.push(items.slice(index, index + size));
  }
  return out;
}

/**
 * `NUMPED IN (@p0, @p1, ...)` — the list length is the ONLY thing that varies.
 *
 * The values are parameters, never text. An interpolated IN list is the classic
 * place a bridge stops being read-only, and these numbers come back over HTTPS
 * from a table the ERP does not own; `@p0..@pN` makes their content irrelevant
 * to how the statement parses.
 */
export function buildAlbaranQuery(numpedCount: number): string {
  if (!Number.isInteger(numpedCount) || numpedCount < 1) {
    throw new Error(`buildAlbaranQuery needs at least one NUMPED, got ${numpedCount}`);
  }
  const placeholders = Array.from({ length: numpedCount }, (_, i) => `@p${i}`).join(", ");
  return (
    "SELECT NUMPED, NUMALB FROM albfacca " +
    `WHERE CAN=@can AND EJEALB=@eje AND NUMPED IN (${placeholders}) ` +
    // ORDER BY is what makes "the first row wins" mean "the LOWEST albarán
    // wins": one pedido delivered in two goes has two albfacca rows, and the
    // portal shows a single NUMALB. The first one issued is the one the customer
    // was told about, and an unordered recordset would pick whichever the query
    // plan happened to emit first — a number that could change between runs.
    "ORDER BY NUMPED, NUMALB"
  );
}

export function buildAlbaranParams(
  numpeds: readonly number[],
  cfg: Pick<BridgeConfig, "can" | "eje">,
): ParamMap {
  const params: ParamMap = { can: P.text(cfg.can), eje: P.int(cfg.eje) };
  numpeds.forEach((numped, index) => {
    params[`p${index}`] = P.int(numped);
  });
  return params;
}

/**
 * NUMPED → the orders waiting on it, and how many injected orders have no NUMPED
 * to wait on.
 *
 * An array of ids rather than one id because the map is built from data, and
 * data surprises: two portal orders should never carry the same NUMPED (the
 * injector's dedup key is per order_number), but if they ever did, marking only
 * one of them would leave the other silently stuck in `injected` forever.
 *
 * A row with a null numped is a portal bug — `bridge_mark_injected` writes the
 * status and the number together — so it is counted and reported, not skipped in
 * silence.
 */
export function indexByNumped(orders: readonly InjectedOrderRef[]): {
  byNumped: Map<number, string[]>;
  withoutNumped: string[];
} {
  const byNumped = new Map<number, string[]>();
  const withoutNumped: string[] = [];
  for (const order of orders) {
    if (typeof order.numped !== "number") {
      withoutNumped.push(order.id);
      continue;
    }
    const existing = byNumped.get(order.numped);
    if (existing) existing.push(order.id);
    else byNumped.set(order.numped, [order.id]);
  }
  return { byNumped, withoutNumped };
}

/** One `albfacca` row, coerced out of whatever the driver handed back. */
export function readAlbaranRow(row: Record<string, unknown>): {
  numped: number | null;
  numalb: number | null;
} {
  return { numped: toNumber(row.NUMPED), numalb: toNumber(row.NUMALB) };
}

export async function runAlbaranSync(deps: AlbaranDeps): Promise<JobResult> {
  const { cfg, api, log, connect } = deps;
  const tally = emptyAlbaranTally();

  const injected = await api.listInjected();
  const { byNumped, withoutNumped } = indexByNumped(injected);
  if (withoutNumped.length) {
    log.error("injected orders without a numped — cannot match an albarán", {
      count: withoutNumped.length,
      orderIds: withoutNumped.slice(0, 10).join(","),
    });
  }
  tally.injected = byNumped.size;

  if (byNumped.size === 0) {
    log.info("nothing awaiting an albarán");
    return { ok: true, counts: albaranCounts(tally) };
  }

  const numpeds = [...byNumped.keys()];
  const pool = await connect(cfg);
  try {
    for (const batch of chunk(numpeds, ALBARAN_CHUNK_SIZE)) {
      const request = pool.request();
      applyParams(request, buildAlbaranParams(batch, cfg));
      const result = await request.query<Record<string, unknown>>(
        buildAlbaranQuery(batch.length),
      );

      for (const raw of result.recordset ?? []) {
        const { numped, numalb } = readAlbaranRow(raw);
        if (numped === null) continue;
        // Absent from the map means either "not a pedido this portal is waiting
        // for" or "already handled by an earlier row of this same run" — a
        // pedido delivered in parts has one albfacca row per delivery.
        const orderIds = byNumped.get(numped);
        if (!orderIds) continue;
        if (numalb === null || numalb <= 0) {
          // An albfacca row with no albarán number is not a conversion we can
          // report; leave the order in `injected` and say so. The pedido stays
          // in the waiting set, so a later row that DOES carry a number still
          // gets its chance.
          log.warn("albfacca row has no usable NUMALB", { numped, numalb });
          continue;
        }
        tally.matched++;
        // Claim the pedido before marking, not after: this is what keeps
        // `matched` at one per pedido and stops a second delivery's row — in
        // this chunk or a later one — from marking the same order twice. A mark
        // that fails is not retried inside the run; the next run re-reads the
        // same albfacca rows and tries again.
        byNumped.delete(numped);
        if (orderIds.length > 1) {
          log.warn("several portal orders carry the same numped", {
            numped,
            orderIds: orderIds.join(","),
          });
        }
        for (const orderId of orderIds) {
          try {
            const marked = await api.markAlbaran(orderId, numalb);
            if (marked) {
              tally.marked++;
              log.info("albarán matched", { orderId, numped, numalb });
            } else {
              // The order was not `injected` any more: staff cancelled it, or a
              // previous run already marked it and the portal list was stale.
              log.error("mark_albaran returned false", { orderId, numped, numalb });
            }
          } catch (error) {
            // Reported, not thrown: the remaining matches are independent and
            // the next run re-reads the same albfacca rows.
            log.logError(error, { orderId, numped, numalb, stage: "mark_albaran" });
          }
        }
      }
    }
  } finally {
    try {
      await pool.close();
    } catch (error) {
      log.logError(error, { stage: "pool_close" });
    }
  }

  return { ok: true, counts: albaranCounts(tally) };
}
