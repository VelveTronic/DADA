/**
 * The Supabase half of the bridge: raw `fetch` against PostgREST with the
 * service-role key.
 *
 * Raw fetch rather than `@supabase/supabase-js` because the bridge ships as one
 * esbuild bundle onto a Windows server: every dependency is code the owner has
 * to trust and we have to rebuild, while this module uses only a small fixed set
 * of RPC and table calls. The client library would add a megabyte to buy
 * nothing.
 *
 * Everything here is service-role. The `bridge_*` functions are EXECUTE-granted
 * to `service_role` alone, so no other key can reach them — which is also why
 * the key never appears in a log line, an error body, or a URL.
 */
import { BRIDGE_SUPABASE_ORIGIN, BridgeConfigError } from "./config";
import type { ClaimedOrder } from "./payload";

/** The server answered, and the answer was not a success. Carries status + body. */
export class SupabaseHttpError extends Error {
  readonly code = "SUPABASE_HTTP";
  readonly status: number;
  readonly path: string;
  readonly body: string;

  constructor(path: string, status: number, body: string) {
    super(`${path} responded ${status}: ${body}`);
    this.name = "SupabaseHttpError";
    this.status = status;
    this.path = path;
    this.body = body;
  }
}

/** The request never got an answer: DNS, TCP, TLS, or our own timeout. */
export class SupabaseNetworkError extends Error {
  readonly code = "SUPABASE_NETWORK";
  readonly path: string;

  constructor(path: string, cause: unknown) {
    super(
      `${path} did not answer: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.name = "SupabaseNetworkError";
    this.path = path;
  }
}

/** The answer parsed, but is not the shape the contract promises. */
export class SupabasePayloadError extends Error {
  readonly code = "SUPABASE_PAYLOAD";
  readonly path: string;

  constructor(path: string, detail: string) {
    super(`${path} returned an unexpected payload: ${detail}`);
    this.name = "SupabasePayloadError";
    this.path = path;
  }
}

export interface InjectedOrderRef {
  id: string;
  orderNumber: number;
  erpCan: string | null;
  erpEje: number | null;
  numped: number | null;
}

export interface HeartbeatRow {
  job: string;
  last_run_at: string;
  ok: boolean;
  detail: unknown;
}

export type OrderFailureOutcome = "requeued" | "terminal" | "stale_claim";

/** Result of the atomic failure-state transition in `bridge_mark_order_failed`. */
export interface OrderFailureMark {
  marked: boolean;
  outcome: OrderFailureOutcome;
  attemptCount: number | null;
}

export interface BridgeSupabase {
  claimConfirmed(
    claimToken: string,
    limit: number,
    leaseSeconds: number,
    orderId: string | null,
  ): Promise<ClaimedOrder[]>;
  markInjected(
    orderId: string,
    claimToken: string,
    can: string,
    eje: number,
    numped: number,
  ): Promise<boolean>;
  backfillOrderIdentity(
    orderId: string,
    can: string,
    eje: number,
    numped: number,
  ): Promise<boolean>;
  markOrderFailed(
    orderId: string,
    claimToken: string,
    errorCode: string,
    errorMessage: string,
    retryable: boolean,
  ): Promise<OrderFailureMark>;
  markAlbaran(
    orderId: string,
    can: string,
    eje: number,
    numalb: number,
  ): Promise<boolean>;
  listInjected(): Promise<InjectedOrderRef[]>;
  /** False when `bridge_status` does not exist yet (Task 3 adds it). */
  heartbeat(row: HeartbeatRow): Promise<boolean>;
  /**
   * False when no product carries that codart — the price-sync miss count.
   *
   * `object` rather than `Record<string, unknown>` because the patch that
   * arrives is a `WingestPricePatch`, and a TypeScript INTERFACE has no implicit
   * index signature: the record type would reject the one caller this method
   * has. Anything JSON-serialisable is acceptable here; PostgREST validates the
   * column names.
   */
  patchProduct(codart: string, patch: object): Promise<boolean>;
  /** `orders` matching `filters`, or null if PostgREST withheld the total. */
  countOrders(filters: Record<string, string>): Promise<number | null>;
  /** `products` matching `filters`, or null if PostgREST withheld the total. */
  countProducts(filters: Record<string, string>): Promise<number | null>;
}

/**
 * The total out of a PostgREST `Content-Range`.
 *
 * The header is `0-24/3573` on a page; an empty page (which is what `limit=0`
 * asks for) puts a bare asterisk before the slash, and a request that did not
 * ask for an exact count puts one after it too. Only the part after the slash
 * matters, and an asterisk there means "not counted" — a null the caller reports
 * rather than a zero it would print as a catalog that just emptied itself.
 */
export function parseContentRangeTotal(value: string | null | undefined): number | null {
  if (!value) return null;
  const slash = value.lastIndexOf("/");
  if (slash < 0) return null;
  const total = value.slice(slash + 1).trim();
  if (!/^\d+$/.test(total)) return null;
  return Number(total);
}

export interface SupabaseClientOptions {
  timeoutMs?: number;
  /** Pause before the single retry. Zero in tests. */
  retryDelayMs?: number;
  fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_RETRY_DELAY_MS = 1_000;
/** Enough of an error body to diagnose; not enough to flood a log file. */
const MAX_ERROR_BODY = 2_000;

/**
 * PostgREST's code for "no such table in the schema cache" — what `bridge_status`
 * answers with between Task 1 and the Task 3 migration that creates it.
 */
const UNDEFINED_TABLE_CODES = ["PGRST205", "42P01"];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createBridgeSupabase(
  cfg: { supabaseUrl: string; supabaseServiceRoleKey: string },
  options: SupabaseClientOptions = {},
): BridgeSupabase {
  // Keep this sink guarded even when a test/future caller constructs config by
  // hand instead of going through loadBridgeConfig.
  if (cfg.supabaseUrl !== BRIDGE_SUPABASE_ORIGIN) {
    throw new BridgeConfigError(
      "BAD_SUPABASE_URL",
      `SUPABASE_URL must be exactly ${BRIDGE_SUPABASE_ORIGIN}`,
    );
  }
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
    fetchImpl = fetch,
  } = options;

  const headers = {
    apikey: cfg.supabaseServiceRoleKey,
    Authorization: `Bearer ${cfg.supabaseServiceRoleKey}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  /**
   * One HTTP round trip with a hard deadline and ONE retry.
   *
   * The retry covers only a request that never got an answer — a dropped
   * connection or our own timeout — because that is the case where the ERP
   * server's flaky link, not the database, is the problem. It is deliberately
   * not a retry on 5xx: the caller can see and decide about a status code, which
   * it cannot do about a socket error. `bridge_claim_confirmed` is safe in this
   * narrow retry window: migration 20260817130000 replays the rows already held
   * by the same claim token instead of leasing a second batch.
   *
   * The known cost: if the FIRST attempt actually reached the database and only
   * the response was lost, the retry sees the world already changed —
   * `markInjected` can then return false and `markOrderFailed` can report a stale
   * claim. The orders job keeps both outcomes alertable; its post-run persistent
   * backlog counts (and later runs) reveal the committed database state rather
   * than silently assuming whether the first response was lost before or after
   * commit.
   */
  async function send(
    path: string,
    init: { method: string; body?: string; extraHeaders?: Record<string, string> },
  ): Promise<{ status: number; text: string; headers: Headers }> {
    const url = `${cfg.supabaseUrl}${path}`;
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0 && retryDelayMs > 0) await sleep(retryDelayMs);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(url, {
          method: init.method,
          headers: { ...headers, ...init.extraHeaders },
          body: init.body,
          signal: controller.signal,
          // Never forward the service-role Authorization header to a redirect
          // target. Config pins the origin too; this closes the HTTP layer.
          redirect: "error",
        });
        const text = await response.text();
        // The count calls read Content-Range; every other caller destructures
        // status and text and lets this fall on the floor.
        return { status: response.status, text, headers: response.headers };
      } catch (error) {
        lastError = error;
      } finally {
        clearTimeout(timer);
      }
    }
    throw new SupabaseNetworkError(path, lastError);
  }

  function parseJson(path: string, text: string): unknown {
    if (!text.trim()) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new SupabasePayloadError(path, `not JSON: ${text.slice(0, 200)}`);
    }
  }

  async function call(
    path: string,
    init: { method: string; body?: string; extraHeaders?: Record<string, string> },
  ): Promise<unknown> {
    const { status, text } = await send(path, init);
    if (status < 200 || status >= 300) {
      throw new SupabaseHttpError(path, status, text.slice(0, MAX_ERROR_BODY));
    }
    return parseJson(path, text);
  }

  /**
   * `bridge_claim_confirmed` returns jsonb, so PostgREST hands back the array
   * itself. The shape check is not paranoia about our own migration: it is what
   * turns "cannot read property items of undefined" three functions later into
   * one line naming the call that lied.
   */
  function assertClaimedOrders(path: string, value: unknown): ClaimedOrder[] {
    if (!Array.isArray(value)) {
      throw new SupabasePayloadError(path, `expected an array, got ${typeof value}`);
    }
    for (const [index, row] of value.entries()) {
      const order = row as Partial<ClaimedOrder> | null;
      if (!order || typeof order !== "object") {
        throw new SupabasePayloadError(path, `row ${index} is not an object`);
      }
      if (typeof order.id !== "string" || typeof order.order_number !== "number") {
        throw new SupabasePayloadError(path, `row ${index} has no id/order_number`);
      }
      if (typeof order.claim_token !== "string") {
        throw new SupabasePayloadError(
          path,
          `order ${order.order_number} has no claim_token`,
        );
      }
      if (typeof order.codcli !== "number") {
        throw new SupabasePayloadError(
          path,
          `order ${order.order_number} has no codcli — the claim must exclude companies without one`,
        );
      }
      if (!Array.isArray(order.items)) {
        throw new SupabasePayloadError(path, `order ${order.order_number} has no items`);
      }
    }
    return value as ClaimedOrder[];
  }

  function assertBoolean(path: string, value: unknown): boolean {
    if (typeof value !== "boolean") {
      throw new SupabasePayloadError(path, `expected a boolean, got ${JSON.stringify(value)}`);
    }
    return value;
  }

  function assertOrderFailureMark(path: string, value: unknown): OrderFailureMark {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new SupabasePayloadError(path, `expected an object, got ${typeof value}`);
    }
    const row = value as {
      marked?: unknown;
      outcome?: unknown;
      attempt_count?: unknown;
    };
    if (typeof row.marked !== "boolean") {
      throw new SupabasePayloadError(path, "result has no boolean marked");
    }
    if (
      row.outcome !== "requeued" &&
      row.outcome !== "terminal" &&
      row.outcome !== "stale_claim"
    ) {
      throw new SupabasePayloadError(
        path,
        `result has invalid outcome ${JSON.stringify(row.outcome)}`,
      );
    }
    if (
      row.attempt_count !== null &&
      (!Number.isInteger(row.attempt_count) || Number(row.attempt_count) < 0)
    ) {
      throw new SupabasePayloadError(
        path,
        `result has invalid attempt_count ${JSON.stringify(row.attempt_count)}`,
      );
    }
    if (row.marked === (row.outcome === "stale_claim")) {
      throw new SupabasePayloadError(
        path,
        `inconsistent marked/outcome ${row.marked}/${row.outcome}`,
      );
    }
    if (
      (row.marked && !Number.isInteger(row.attempt_count)) ||
      (!row.marked && row.attempt_count !== null)
    ) {
      throw new SupabasePayloadError(
        path,
        `inconsistent marked/attempt_count ${row.marked}/${JSON.stringify(row.attempt_count)}`,
      );
    }
    return {
      marked: row.marked,
      outcome: row.outcome,
      attemptCount: row.attempt_count as number | null,
    };
  }

  return {
    async claimConfirmed(claimToken, limit, leaseSeconds, orderId) {
      const path = "/rest/v1/rpc/bridge_claim_confirmed";
      const value = await call(path, {
        method: "POST",
        body: JSON.stringify({
          p_claim_token: claimToken,
          p_limit: limit,
          p_lease_seconds: leaseSeconds,
          p_order_id: orderId,
        }),
      });
      return assertClaimedOrders(path, value);
    },

    async markInjected(orderId, claimToken, can, eje, numped) {
      const path = "/rest/v1/rpc/bridge_mark_injected";
      const value = await call(path, {
        method: "POST",
        body: JSON.stringify({
          p_order_id: orderId,
          p_claim_token: claimToken,
          p_can: can,
          p_eje: eje,
          p_numped: numped,
        }),
      });
      return assertBoolean(path, value);
    },

    async backfillOrderIdentity(orderId, can, eje, numped) {
      const path = "/rest/v1/rpc/bridge_backfill_order_identity";
      const value = await call(path, {
        method: "POST",
        body: JSON.stringify({
          p_order_id: orderId,
          p_can: can,
          p_eje: eje,
          p_numped: numped,
        }),
      });
      return assertBoolean(path, value);
    },

    async markOrderFailed(orderId, claimToken, errorCode, errorMessage, retryable) {
      const path = "/rest/v1/rpc/bridge_mark_order_failed";
      const value = await call(path, {
        method: "POST",
        body: JSON.stringify({
          p_order_id: orderId,
          p_claim_token: claimToken,
          p_error_code: errorCode,
          p_error_message: errorMessage,
          p_retryable: retryable,
        }),
      });
      return assertOrderFailureMark(path, value);
    },

    async markAlbaran(orderId, can, eje, numalb) {
      const path = "/rest/v1/rpc/bridge_mark_albaran";
      const value = await call(path, {
        method: "POST",
        body: JSON.stringify({
          p_order_id: orderId,
          p_can: can,
          p_eje: eje,
          p_numalb: numalb,
        }),
      });
      return assertBoolean(path, value);
    },

    async listInjected() {
      const path =
        "/rest/v1/orders?status=eq.injected&select=id,order_number,erp_can,erp_eje,numped";
      const value = await call(path, { method: "GET" });
      if (!Array.isArray(value)) {
        throw new SupabasePayloadError(path, `expected an array, got ${typeof value}`);
      }
      return value.map((row, index) => {
        if (!row || typeof row !== "object" || Array.isArray(row)) {
          throw new SupabasePayloadError(path, `row ${index} is not an object`);
        }
        const order = row as {
          id?: unknown;
          order_number?: unknown;
          erp_can?: unknown;
          erp_eje?: unknown;
          numped?: unknown;
        };
        if (typeof order.id !== "string" || order.id.length === 0) {
          throw new SupabasePayloadError(path, `row ${index} has no id`);
        }
        if (
          typeof order.order_number !== "number" ||
          !Number.isSafeInteger(order.order_number) ||
          order.order_number <= 0
        ) {
          throw new SupabasePayloadError(
            path,
            `row ${index} has invalid order_number ${JSON.stringify(order.order_number)}`,
          );
        }
        if (
          order.erp_can !== null &&
          (typeof order.erp_can !== "string" ||
            order.erp_can.length < 1 ||
            order.erp_can.length > 2 ||
            order.erp_can !== order.erp_can.trim() ||
            order.erp_can !== order.erp_can.toUpperCase())
        ) {
          throw new SupabasePayloadError(
            path,
            `row ${index} has invalid erp_can ${JSON.stringify(order.erp_can)}`,
          );
        }
        for (const [field, number] of [
          ["erp_eje", order.erp_eje],
          ["numped", order.numped],
        ] as const) {
          if (number !== null && !Number.isInteger(number)) {
            throw new SupabasePayloadError(
              path,
              `row ${index} has invalid ${field} ${JSON.stringify(number)}`,
            );
          }
        }
        return {
          id: order.id,
          orderNumber: order.order_number,
          erpCan: order.erp_can as string | null,
          erpEje: order.erp_eje as number | null,
          numped: order.numped as number | null,
        };
      });
    },

    /**
     * One product's price/unit merge, matched by codart.
     *
     * `return=representation` with `select=codart` is what makes the return
     * value mean anything: PostgREST answers 204 to a PATCH that matched
     * nothing exactly as it does to one that matched a row, so without asking
     * for the rows back, "this codart is not in the portal" would be
     * indistinguishable from "updated". That distinction IS the price-sync
     * accounting (matched vs notInPortal), the same one the CSV importer gets
     * from supabase-js's `.select("codart")`.
     */
    async patchProduct(codart, patch) {
      const query = new URLSearchParams({ codart: `eq.${codart}`, select: "codart" });
      const path = `/rest/v1/products?${query.toString()}`;
      const value = await call(path, {
        method: "PATCH",
        body: JSON.stringify(patch),
        extraHeaders: { Prefer: "return=representation" },
      });
      if (!Array.isArray(value)) {
        throw new SupabasePayloadError(path, `expected an array, got ${typeof value}`);
      }
      // codart is unique, so this is 0 or 1 and a row tally would only restate it.
      return value.length > 0;
    },

    /**
     * Exact current order backlog count for the heartbeat's persistent health.
     *
     * These are GETs under the service-role key, so retries are idempotent. The
     * body is deliberately empty (`limit=0`); only Content-Range is needed.
     */
    async countOrders(filters) {
      const query = new URLSearchParams({ ...filters, select: "id", limit: "0" });
      const path = `/rest/v1/orders?${query.toString()}`;
      const { status, text, headers: responseHeaders } = await send(path, {
        method: "GET",
        extraHeaders: { Prefer: "count=exact" },
      });
      if (status < 200 || status >= 300) {
        throw new SupabaseHttpError(path, status, text.slice(0, MAX_ERROR_BODY));
      }
      return parseContentRangeTotal(responseHeaders.get("content-range"));
    },

    /**
     * `count=exact` over `products`, for the post-sync diagnostics.
     *
     * `limit=0` because the count travels in the Content-Range header and the
     * body is not wanted: the fully-unpriced query would otherwise drag several
     * hundred rows over a domestic ADSL line to be thrown away.
     */
    async countProducts(filters) {
      const query = new URLSearchParams({ ...filters, select: "codart", limit: "0" });
      const path = `/rest/v1/products?${query.toString()}`;
      const { status, text, headers: responseHeaders } = await send(path, {
        method: "GET",
        extraHeaders: { Prefer: "count=exact" },
      });
      if (status < 200 || status >= 300) {
        throw new SupabaseHttpError(path, status, text.slice(0, MAX_ERROR_BODY));
      }
      return parseContentRangeTotal(responseHeaders.get("content-range"));
    },

    /**
     * Upsert one row per job. Tolerant of a missing table on purpose: Tasks 1
     * and 2 run against a database that does not have `bridge_status` yet, and a
     * heartbeat is telemetry — it must never be the reason a run that already
     * injected orders reports failure.
     */
    async heartbeat(row) {
      const path = "/rest/v1/bridge_status?on_conflict=job";
      const { status, text } = await send(path, {
        method: "POST",
        body: JSON.stringify(row),
        extraHeaders: { Prefer: "resolution=merge-duplicates,return=minimal" },
      });
      if (status >= 200 && status < 300) return true;
      if (status === 404) {
        const parsed = parseJson(path, text) as { code?: unknown } | null;
        if (
          !parsed ||
          typeof parsed.code !== "string" ||
          UNDEFINED_TABLE_CODES.includes(parsed.code)
        ) {
          return false;
        }
      }
      throw new SupabaseHttpError(path, status, text.slice(0, MAX_ERROR_BODY));
    },
  };
}
