/**
 * The orders job: claim confirmed portal orders, inject each as a Wingest
 * pedido, tell the portal what number it got.
 *
 * The one rule that shapes everything here: **a bad order must never block the
 * queue.** Whatever happens to one order — the injector throws, the ERP is
 * missing its codart, the mark comes back false — is logged with the full
 * context and the loop moves to the next one. Nothing is retried in-process.
 *
 * That is not resignation, it is the design: `bridge_claim_confirmed` handed us
 * a LEASE, and a lease that is never marked expires. The order goes back to
 * claimable on its own and the next run picks it up, with the crash window
 * covered from the other side by the injector's dedup recovery (the re-claimed
 * order finds its own pedido by `PORTAL-<n>` and returns that NUMPED instead of
 * writing a second one). An in-process retry loop would add a way to inject
 * twice in exchange for a robustness we already have.
 */
import type * as sql from "mssql";
import type { BridgeConfig } from "../config";
import type { InjectResult } from "../injector";
import type { Logger } from "../log";
import type { ClaimedOrder } from "../payload";
import type { BridgeSupabase } from "../supabase";
import type { JobCounts, JobResult } from "./shared";

export interface OrdersDeps {
  cfg: BridgeConfig;
  api: Pick<BridgeSupabase, "claimConfirmed" | "markInjected">;
  log: Logger;
  connect: (cfg: BridgeConfig) => Promise<sql.ConnectionPool>;
  inject: (
    pool: sql.ConnectionPool,
    cfg: BridgeConfig,
    order: ClaimedOrder,
  ) => Promise<InjectResult>;
  /** `crypto.randomUUID` in production; a fixed string in tests. */
  newToken: () => string;
}

/**
 * The five numbers a run is judged by.
 *
 * `injected` and `recovered` are DISJOINT and together with `failed` they add up
 * to `claimed` — every claimed order lands in exactly one of them. `markFailed`
 * is the odd one out: it counts a subset of the orders already counted in
 * `injected` or `recovered`, because a mark can only fail on an order whose
 * pedido exists. It is the alertable number.
 */
export interface OrdersTally {
  /** Orders `bridge_claim_confirmed` leased to this run. */
  claimed: number;
  /** Orders that got a NEW pedido written this run. */
  injected: number;
  /** Orders whose pedido was already there and whose NUMPED we recovered. */
  recovered: number;
  /** Pedido exists, portal was NOT told: mark returned false, or the call threw. */
  markFailed: number;
  /** The injector threw; nothing was written and the lease will expire. */
  failed: number;
}

export function emptyOrdersTally(): OrdersTally {
  return { claimed: 0, injected: 0, recovered: 0, markFailed: 0, failed: 0 };
}

/** The summary line's fields, in the order the plan names them. */
export function ordersCounts(tally: OrdersTally): JobCounts {
  return {
    claimed: tally.claimed,
    injected: tally.injected,
    recovered: tally.recovered,
    markFailed: tally.markFailed,
    failed: tally.failed,
  };
}

/**
 * The context every per-order log line carries. An alert naming only "inject
 * failed" is one nobody can action; these three are what an operator types into
 * the portal and into Wingest to see the same order from both sides.
 */
function orderFields(order: ClaimedOrder): JobCounts {
  return {
    orderId: order.id,
    orderNumber: order.order_number,
    company: order.company_name,
    codcli: order.codcli,
  };
}

export async function runOrders(deps: OrdersDeps): Promise<JobResult> {
  const { cfg, api, log, connect, inject, newToken } = deps;
  const tally = emptyOrdersTally();

  // ONE token for the whole run. It is the key `bridge_mark_injected` checks
  // against the row, so a per-order token would mark nothing: the RPC only
  // flips a `processing` row holding the SAME token that claimed it.
  const claimToken = newToken();
  const orders = await api.claimConfirmed(claimToken, cfg.claimLimit, cfg.leaseSeconds);
  tally.claimed = orders.length;

  // Nothing to do — and this job runs every minute, so "nothing to do" must not
  // open a SQL connection. Ninety-nine runs out of a hundred stop here.
  if (orders.length === 0) {
    log.info("nothing to inject", { claimToken });
    return { ok: true, counts: ordersCounts(tally) };
  }

  log.info("claimed", { claimToken, count: orders.length });

  const pool = await connect(cfg);
  try {
    // Sequential on purpose: the injector reserves counters in `newcontador`
    // inside a SERIALIZABLE transaction, and two orders in flight would take
    // those same rows in the same order and block each other. The queue is
    // twenty orders at most.
    for (const order of orders) {
      let result: InjectResult;
      try {
        result = await inject(pool, cfg, order);
      } catch (error) {
        tally.failed++;
        // The lease is the retry: nothing is re-attempted here, and the order
        // stays `processing` until it expires back into the claimable set.
        log.logError(error, { ...orderFields(order), stage: "inject" });
        continue;
      }

      if (result.recovered) {
        tally.recovered++;
      } else {
        tally.injected++;
      }
      log.info(result.recovered ? "recovered existing pedido" : "injected", {
        ...orderFields(order),
        numped: result.numped,
        // 0 on the recovery path by contract (InjectResult.lineCount): the
        // pedido was already there and this run wrote no lines.
        lineCount: result.lineCount,
        excluded: result.excludedCodarts.length
          ? result.excludedCodarts.join(",")
          : null,
      });

      try {
        const marked = await api.markInjected(order.id, claimToken, result.numped);
        if (!marked) {
          tally.markFailed++;
          // False means the row was not `processing` with our token any more:
          // the lease expired mid-injection and someone else holds it, or staff
          // moved the order. The pedido is REAL either way — that is why this is
          // an ERROR and not a warning.
          log.error("mark_injected returned false — pedido exists, portal not updated", {
            ...orderFields(order),
            numped: result.numped,
            claimToken,
          });
        }
      } catch (error) {
        // Same outcome as a false return (pedido written, portal not told), so
        // it is counted the same way. The next run re-claims the order, the
        // injector's dedup finds this exact pedido, and the mark is retried
        // against the same NUMPED.
        tally.markFailed++;
        log.logError(error, {
          ...orderFields(order),
          numped: result.numped,
          stage: "mark_injected",
        });
      }
    }
  } finally {
    // A pool that will not close must not turn a run that injected orders into a
    // failed one; the process is about to exit and take the socket with it.
    try {
      await pool.close();
    } catch (error) {
      log.logError(error, { stage: "pool_close" });
    }
  }

  return { ok: true, counts: ordersCounts(tally) };
}
