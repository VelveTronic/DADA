/**
 * The orders job: claim confirmed portal orders, inject each as a Wingest
 * pedido, tell the portal what number it got.
 *
 * The one rule that shapes everything here: **a bad order must never block the
 * queue.** Ordinary per-order failures are recorded and the loop moves on.
 * The sole exception is an uncertain commit/rollback: that connection is no
 * longer safe, so every unattempted claimed order is atomically requeued before
 * the pool is closed. Nothing is retried in-process.
 *
 * `bridge_claim_confirmed` hands us a LEASE. On an injector failure an atomic
 * failure RPC either schedules a backed-off retry or moves the order to the
 * staff queue; if that RPC cannot record the outcome, lease expiry remains the
 * safety net. The crash-after-ERP-write window is covered from the other side
 * by dedup recovery: a re-claimed order finds its own pedido by `PORTAL-<n>` and
 * returns that NUMPED rather than writing a second one. An in-process retry loop
 * would add a duplicate-write path without improving those guarantees.
 */
import type * as sql from "mssql";
import {
  BridgeConfigError,
  bridgeSecrets,
  isCanonicalUuid,
  type BridgeConfig,
} from "../config";
import { InjectError, type InjectResult } from "../injector";
import { redactSecrets, type LogFields, type Logger } from "../log";
import { PayloadError, type ClaimedOrder } from "../payload";
import type { BridgeSupabase } from "../supabase";
import type { JobCounts, JobResult } from "./shared";

export interface OrdersDeps {
  cfg: BridgeConfig;
  api: Pick<
    BridgeSupabase,
    "claimConfirmed" | "markInjected" | "markOrderFailed" | "countOrders"
  >;
  log: Logger;
  connect: (cfg: BridgeConfig) => Promise<sql.ConnectionPool>;
  inject: (
    pool: sql.ConnectionPool,
    cfg: BridgeConfig,
    order: ClaimedOrder,
  ) => Promise<InjectResult>;
  /** `crypto.randomUUID` in production; a fixed string in tests. */
  newToken: () => string;
  /** Madrid business clock; wired from `MainDeps.now`, fixed at year edges in tests. */
  now: () => Date;
}

const MADRID_YEAR_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: "Europe/Madrid",
  year: "numeric",
});

/** The two-digit Wingest fiscal-year key at one instant in Madrid. */
export function madridEjeAt(now: Date): number {
  if (!Number.isFinite(now.getTime())) throw new Error("INVALID_BRIDGE_CLOCK");
  const year = MADRID_YEAR_FORMATTER.formatToParts(now).find(
    (part) => part.type === "year",
  )?.value;
  if (!year || !/^\d{4}$/.test(year)) throw new Error("INVALID_BRIDGE_CLOCK");
  return Number(year) % 100;
}

/** Stable startup failure: no portal order has been claimed when this is thrown. */
export class EjeYearMismatchError extends Error {
  readonly code = "EJE_YEAR_MISMATCH";
  readonly configuredEje: number;
  readonly madridEje: number;

  constructor(configuredEje: number, madridEje: number) {
    super(
      `EJE_YEAR_MISMATCH: BRIDGE_EJE=${configuredEje}, Europe/Madrid current EJE=${madridEje}`,
    );
    this.name = "EjeYearMismatchError";
    this.configuredEje = configuredEje;
    this.madridEje = madridEje;
  }
}

/**
 * The success, failure-state and alert counters a run is judged by.
 *
 * `injected` and `recovered` are DISJOINT and together with `failed` they add up
 * to `claimed` — every claimed order lands in exactly one of them. Failure
 * handling has its own partition: `requeued + terminal + failureMarkFailed =
 * failed`. `markFailed` is the odd one out: it counts a subset of the orders
 * already counted in `injected` or `recovered`, because a mark can only fail on
 * an order whose pedido exists.
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
  /** The injector threw; nothing was written. */
  failed: number;
  /** Failed orders atomically returned to `confirmed` with a DB-owned backoff. */
  requeued: number;
  /** Failed orders moved to `bridge_failed` for an explicit staff decision. */
  terminal: number;
  /** Failure RPC threw or rejected our claim; the lease remains the fallback. */
  failureMarkFailed: number;
  /** Current `bridge_failed` rows, independent of what this run claimed. */
  manualRequired: number | null;
  /** Current backed-off `confirmed` rows with a previous bridge failure. */
  retryPending: number | null;
  /** Current leased rows; after a run these normally mean an unresolved mark gap. */
  processingPending: number | null;
  /** Backlog counts that threw, were withheld, or returned an invalid total. */
  backlogCountError: number;
}

export function emptyOrdersTally(): OrdersTally {
  return {
    claimed: 0,
    injected: 0,
    recovered: 0,
    markFailed: 0,
    failed: 0,
    requeued: 0,
    terminal: 0,
    failureMarkFailed: 0,
    manualRequired: 0,
    retryPending: 0,
    processingPending: 0,
    backlogCountError: 0,
  };
}

/** The heartbeat fields in the stable order used by the staff status card. */
export function ordersCounts(tally: OrdersTally): JobCounts {
  return {
    claimed: tally.claimed,
    injected: tally.injected,
    recovered: tally.recovered,
    failed: tally.failed,
    requeued: tally.requeued,
    terminal: tally.terminal,
    markFailed: tally.markFailed,
    failureMarkFailed: tally.failureMarkFailed,
    manualRequired: tally.manualRequired,
    retryPending: tally.retryPending,
    processingPending: tally.processingPending,
    backlogCountError: tally.backlogCountError,
  };
}

type BacklogCountKey =
  | "manualRequired"
  | "retryPending"
  | "processingPending";

const ORDER_BACKLOG_QUERIES: readonly {
  key: BacklogCountKey;
  filters: Record<string, string>;
}[] = [
  { key: "manualRequired", filters: { status: "eq.bridge_failed" } },
  {
    key: "retryPending",
    filters: { status: "eq.confirmed", bridge_attempt_count: "gt.0" },
  },
  { key: "processingPending", filters: { status: "eq.processing" } },
];

/**
 * Replace per-run guesses with the portal's current persistent backlog.
 *
 * All three exact-count GETs run together. A missing Content-Range is as
 * uncertain as a thrown request: its field becomes null and the explicit error
 * counter prevents the staff card from painting an unmeasured queue green.
 */
async function measureOrderBacklog(
  api: Pick<BridgeSupabase, "countOrders">,
  tally: OrdersTally,
  log: Logger,
): Promise<void> {
  const results = await Promise.allSettled(
    ORDER_BACKLOG_QUERIES.map(({ filters }) => api.countOrders(filters)),
  );
  tally.backlogCountError = 0;

  for (const [index, result] of results.entries()) {
    const { key } = ORDER_BACKLOG_QUERIES[index];
    if (
      result.status === "fulfilled" &&
      result.value !== null &&
      Number.isSafeInteger(result.value) &&
      result.value >= 0
    ) {
      tally[key] = result.value;
      continue;
    }

    tally[key] = null;
    tally.backlogCountError++;
    if (result.status === "rejected") {
      log.logError(result.reason, { stage: "order_backlog_count", counter: key });
    } else {
      log.error("order backlog count unavailable", {
        stage: "order_backlog_count",
        counter: key,
        value: result.value,
      });
    }
  }
}

export const MAX_FAILURE_MESSAGE_LENGTH = 1_000;
export const MAX_FAILURE_CODE_LENGTH = 100;

export interface ClassifiedOrderFailure {
  code: string;
  message: string;
  retryable: boolean;
}

/** Stable run-level failure when one ERP transaction makes its pool unsafe. */
export const BATCH_ABORTED_UNSAFE_ERP_CONNECTION =
  "BATCH_ABORTED_UNSAFE_ERP_CONNECTION";

const BATCH_ABORTED_MESSAGE =
  "Order was not attempted because an earlier ERP transaction left the SQL connection unsafe";

/**
 * Turn any injector throw into the small, stable contract persisted by the
 * portal. Known payload/business failures keep their explicit code and are
 * permanent. Unknown failures are deliberately retryable: DNS, timeouts,
 * deadlocks and driver errors do not all share one dependable JS class, and the
 * database's attempt ceiling prevents this conservative choice looping forever.
 */
export function classifyOrderFailure(
  error: unknown,
  secrets: readonly string[] = [],
): ClassifiedOrderFailure {
  const known = error instanceof InjectError || error instanceof PayloadError;
  const rawCode = known ? error.code : "UNEXPECTED_INJECT_ERROR";
  const retryable =
    error instanceof InjectError ? error.retryable : !(error instanceof PayloadError);
  const raw = error instanceof Error ? error.message : String(error);
  const compact = raw.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  const redacted = redactSecrets(compact || "unknown injector failure", secrets);
  const code = redactSecrets(rawCode, secrets)
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, MAX_FAILURE_CODE_LENGTH);
  return {
    code: code || "UNKNOWN_ERROR",
    message: redacted.slice(0, MAX_FAILURE_MESSAGE_LENGTH),
    retryable,
  };
}

/**
 * The context every per-order log line carries. An alert naming only "inject
 * failed" is one nobody can action; these three are what an operator types into
 * the portal and into Wingest to see the same order from both sides.
 */
function orderFields(order: ClaimedOrder): LogFields {
  return {
    orderId: order.id,
    orderNumber: order.order_number,
    company: order.company_name,
    codcli: order.codcli,
  };
}

async function recordOrderFailure(
  api: Pick<BridgeSupabase, "markOrderFailed">,
  log: Logger,
  tally: OrdersTally,
  order: ClaimedOrder,
  claimToken: string,
  failure: ClassifiedOrderFailure,
): Promise<void> {
  // No in-process retry: one atomic RPC either schedules a later attempt with
  // backoff or moves the order to the staff queue. A stale token means another
  // actor owns the row, so the bridge reports it instead of overwriting that
  // newer decision.
  try {
    const marked = await api.markOrderFailed(
      order.id,
      claimToken,
      failure.code,
      failure.message,
      failure.retryable,
    );
    if (!marked.marked || marked.outcome === "stale_claim") {
      tally.failureMarkFailed++;
      log.error("mark_order_failed rejected the claim", {
        ...orderFields(order),
        failureCode: failure.code,
        claimToken,
        attemptCount: marked.attemptCount,
      });
    } else if (marked.outcome === "terminal") {
      tally.terminal++;
      log.error("order moved to bridge_failed", {
        ...orderFields(order),
        failureCode: failure.code,
        retryable: failure.retryable,
        attemptCount: marked.attemptCount,
      });
    } else {
      tally.requeued++;
      log.warn("order failure recorded; retry scheduled", {
        ...orderFields(order),
        failureCode: failure.code,
        attemptCount: marked.attemptCount,
      });
    }
  } catch (markError) {
    tally.failureMarkFailed++;
    log.logError(markError, {
      ...orderFields(order),
      failureCode: failure.code,
      stage: "mark_order_failed",
    });
  }
}

export async function runOrders(deps: OrdersDeps): Promise<JobResult> {
  const { cfg, api, log, connect, inject, newToken, now } = deps;
  const tally = emptyOrdersTally();

  // Treat BridgeConfig as untrusted at this boundary too. Production reaches
  // here through loadBridgeConfig, but tests and future callers can construct
  // the object directly; neither may turn a broad queue run into an accidental
  // historical run (or leave a target armed after the switch is disabled).
  if (cfg.allowHistoricalEje !== true && cfg.allowHistoricalEje !== false) {
    throw new BridgeConfigError(
      "BAD_HISTORICAL_ORDER_CONFIG",
      "allowHistoricalEje must be a boolean",
    );
  }
  const historicalOverride = cfg.allowHistoricalEje === true;
  if (historicalOverride && !isCanonicalUuid(cfg.historicalOrderId)) {
    throw new BridgeConfigError(
      "BAD_HISTORICAL_ORDER_CONFIG",
      "historicalOrderId must be one canonical UUID when allowHistoricalEje is true",
    );
  }
  if (!historicalOverride && cfg.historicalOrderId !== null) {
    throw new BridgeConfigError(
      "BAD_HISTORICAL_ORDER_CONFIG",
      "historicalOrderId must be null when allowHistoricalEje is false",
    );
  }
  const historicalOrderId = historicalOverride ? cfg.historicalOrderId : null;

  // This is deliberately before the claim: a stale BRIDGE_EJE must leave every
  // confirmed order untouched, not lease a batch that this run refuses to write.
  const madridEje = madridEjeAt(now());
  if (historicalOverride) {
    log.warn("single-order historical ERP override enabled", {
      code: "HISTORICAL_ORDER_OVERRIDE",
      orderId: historicalOrderId,
      configuredEje: cfg.eje,
      madridEje,
    });
  } else if (cfg.eje !== madridEje) {
    throw new EjeYearMismatchError(cfg.eje, madridEje);
  }

  // ONE token for the whole run. It is the key `bridge_mark_injected` checks
  // against the row, so a per-order token would mark nothing: the RPC only
  // flips a `processing` row holding the SAME token that claimed it.
  const claimToken = newToken();
  const orders = await api.claimConfirmed(
    claimToken,
    historicalOverride ? 1 : cfg.claimLimit,
    cfg.leaseSeconds,
    historicalOrderId,
  );
  if (
    historicalOrderId !== null &&
    (orders.length > 1 || orders.some((order) => order.id !== historicalOrderId))
  ) {
    throw new BridgeConfigError(
      "HISTORICAL_CLAIM_SCOPE_VIOLATION",
      "bridge_claim_confirmed returned an order outside the configured historical target",
    );
  }
  tally.claimed = orders.length;

  // Nothing to do — and this job runs every minute, so "nothing to do" must not
  // open a SQL connection. Ninety-nine runs out of a hundred stop here.
  if (orders.length === 0) {
    log.info("nothing to inject", { claimToken });
    await measureOrderBacklog(api, tally, log);
    return { ok: true, counts: ordersCounts(tally) };
  }

  log.info("claimed", { claimToken, count: orders.length });

  const pool = await connect(cfg);
  let batchAbortCode: typeof BATCH_ABORTED_UNSAFE_ERP_CONNECTION | null = null;
  try {
    // Sequential on purpose: the injector reserves counters in `newcontador`
    // inside a SERIALIZABLE transaction, and two orders in flight would take
    // those same rows in the same order and block each other. The batch is
    // CLAIM_LIMIT orders — 20 by default, 200 at the ceiling `config.ts`
    // enforces — so the whole run is seconds even at the top of that range.
    for (let orderIndex = 0; orderIndex < orders.length; orderIndex++) {
      const order = orders[orderIndex];
      let result: InjectResult;
      try {
        result = await inject(pool, cfg, order);
      } catch (error) {
        tally.failed++;
        const failure = classifyOrderFailure(error, bridgeSecrets(cfg));
        const abortBatch = error instanceof InjectError && error.abortBatch;
        log.logError(error, {
          ...orderFields(order),
          stage: "inject",
          failureCode: failure.code,
          retryable: failure.retryable,
        });

        await recordOrderFailure(api, log, tally, order, claimToken, failure);

        if (abortBatch) {
          batchAbortCode = BATCH_ABORTED_UNSAFE_ERP_CONNECTION;
          const remaining = orders.slice(orderIndex + 1);
          log.error("aborting claimed batch after unsafe ERP transaction outcome", {
            ...orderFields(order),
            failureCode: failure.code,
            remaining: remaining.length,
          });

          // These rows share this run's claim token and have not touched SQL.
          // Mark every one through the same atomic failure RPC rather than
          // leaving it in `processing` until lease expiry.
          const batchFailure: ClassifiedOrderFailure = {
            code: BATCH_ABORTED_UNSAFE_ERP_CONNECTION,
            message: BATCH_ABORTED_MESSAGE,
            retryable: true,
          };
          for (const unattempted of remaining) {
            tally.failed++;
            await recordOrderFailure(
              api,
              log,
              tally,
              unattempted,
              claimToken,
              batchFailure,
            );
          }
          break;
        }
        continue;
      }

      if (result.recovered) {
        tally.recovered++;
      } else {
        tally.injected++;
      }
      log.info(result.recovered ? "recovered existing pedido" : "injected", {
        ...orderFields(order),
        can: result.can,
        eje: result.eje,
        numped: result.numped,
        // 0 on the recovery path by contract (InjectResult.lineCount): the
        // pedido was already there and this run wrote no lines.
        lineCount: result.lineCount,
        excluded: result.excludedCodarts.length
          ? result.excludedCodarts.join(",")
          : null,
      });

      try {
        const marked = await api.markInjected(
          order.id,
          claimToken,
          result.can,
          result.eje,
          result.numped,
        );
        if (!marked) {
          tally.markFailed++;
          // False means the row was not `processing` with our token any more:
          // the lease expired mid-injection and someone else holds it, or staff
          // moved the order. The pedido is REAL either way — that is why this is
          // an ERROR and not a warning.
          log.error("mark_injected returned false — pedido exists, portal not updated", {
            ...orderFields(order),
            can: result.can,
            eje: result.eje,
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
          can: result.can,
          eje: result.eje,
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

  await measureOrderBacklog(api, tally, log);
  if (batchAbortCode !== null) {
    return {
      ok: false,
      counts: { ...ordersCounts(tally), code: batchAbortCode },
    };
  }
  return { ok: true, counts: ordersCounts(tally) };
}
